// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The Preview pane's wire: the pages a session owns and the verbs that move them, the dev servers the daemon discovers, the marks sent to the provider, and the live picture for another device with the input, menu acts, chosen files and saves that answer it.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { ArtifactId } from "../artifacts/id.js";
import type { HexColor } from "../color.js";
import type { Port } from "../internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
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

// prettier-ignore
const schema2418: any = {"description":"Why a parsed address is not a web address the app opens: `scheme` when its scheme is neither\n`http:` nor `https:`.","type":"string","enum":["scheme"]};
// prettier-ignore
const schema2419: any = {"description":"A refused address's text that is not an address at all.","type":"string","enum":["notAnAddress"]};
// prettier-ignore
function validate1296(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1296.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(typeof data !== "string"){const err0: any = {instancePath,schemaPath:"sidekicks-contracts:web-address#/$defs/WebAddressFault/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(!(data === "scheme")){const err1: any = {instancePath,schemaPath:"sidekicks-contracts:web-address#/$defs/WebAddressFault/enum",keyword:"enum",params:{allowedValues: schema2418.enum}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;const _errs4: any = errors;if(typeof data !== "string"){const err2: any = {instancePath,schemaPath:"#/$defs/PreviewUnparsedAddress/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(!(data === "notAnAddress")){const err3: any = {instancePath,schemaPath:"#/$defs/PreviewUnparsedAddress/enum",keyword:"enum",params:{allowedValues: schema2419.enum}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs4 === errors;valid0 = valid0 || _valid0;if(!valid0){const err4: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate1296.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1296.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1296.errors = null as any[] | null;
// prettier-ignore
validate1296.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1295(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewAddressRefusedDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1295.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.reason === undefined) && (missing0 = "reason")){validate1295.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "reason")){validate1295.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reason !== undefined){if(!(validate1296.call(this, data.reason, {instancePath:instancePath+"/reason",parentData:data,parentDataProperty:"reason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1296.errors : vErrors.concat(validate1296.errors);errors = vErrors.length;}}}}}else {validate1295.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1295.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1295.errors = null as any[] | null;
// prettier-ignore
validate1295.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2421: any = {"type":"object","additionalProperties":false,"properties":{"port":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Port","description":"Its port."},"name":{"type":["string","null"],"minLength":1,"description":"The name it gave."},"framework":{"type":["string","null"],"minLength":1,"description":"Its framework."},"startedHere":{"type":"boolean","description":"Whether this session started it, by its agent or in its own shell."}},"required":["port","name","framework","startedHere"],"description":"One dev server the daemon found listening in the session's project. `name` and `framework` are\n`null` where the daemon could not tell; `startedHere` means this session started it."};
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1300(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1300.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.port === undefined) && (missing0 = "port")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.framework === undefined) && (missing0 = "framework"))) || ((data.startedHere === undefined) && (missing0 = "startedHere"))){validate1300.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "port") || (key0 === "name")) || (key0 === "framework")) || (key0 === "startedHere"))){validate1300.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.port !== undefined){let data0: any = data.port;const _errs2: any = errors;const _errs3: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate1300.errors = [{instancePath:instancePath+"/port",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 65535 || isNaN(data0)){validate1300.errors = [{instancePath:instancePath+"/port",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/maximum",keyword:"maximum",params:{comparison: "<=", limit: 65535}}];return false;}else {if(data0 < 1 || isNaN(data0)){validate1300.errors = [{instancePath:instancePath+"/port",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs5: any = errors;if((typeof data1 !== "string") && (data1 !== null)){validate1300.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: schema2421.properties.name.type}}];return false;}if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate1300.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.framework !== undefined){let data2: any = data.framework;const _errs7: any = errors;if((typeof data2 !== "string") && (data2 !== null)){validate1300.errors = [{instancePath:instancePath+"/framework",schemaPath:"#/properties/framework/type",keyword:"type",params:{type: schema2421.properties.framework.type}}];return false;}if(errors === _errs7){if(typeof data2 === "string"){if(func1(data2) < 1){validate1300.errors = [{instancePath:instancePath+"/framework",schemaPath:"#/properties/framework/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.startedHere !== undefined){const _errs9: any = errors;if(typeof data.startedHere !== "boolean"){validate1300.errors = [{instancePath:instancePath+"/startedHere",schemaPath:"#/properties/startedHere/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}}else {validate1300.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1300.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1300.errors = null as any[] | null;
// prettier-ignore
validate1300.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1299(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDevServerListFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1299.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(Array.isArray(data)){var valid0: any = true;const len0: any = data.length;for(let i0=0; i0<len0; i0++){const _errs1: any = errors;if(!(validate1300.call(this, data[i0], {instancePath:instancePath+"/" + i0,parentData:data,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1300.errors : vErrors.concat(validate1300.errors);errors = vErrors.length;}var valid0: any = _errs1 === errors;if(!valid0){break;}}}else {validate1299.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "array"}}];return false;}}validate1299.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1299.errors = null as any[] | null;
// prettier-ignore
validate1299.evaluated = {"items":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate1302(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDevServerSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1302.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1302.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1302.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1302.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1302.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1302.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1302.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1302.errors = null as any[] | null;
// prettier-ignore
validate1302.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1303(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewInputMessageId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1303.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validate1303.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validate1303.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1303.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1303.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1303.errors = null as any[] | null;
// prettier-ignore
validate1303.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2430: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"comment"},"number":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"Its number."},"note":{"type":["string","null"],"minLength":1,"maxLength":4096,"description":"The person's note; `null` where they wrote none."},"point":{"$ref":"#/$defs/PreviewPoint","description":"Where it is pinned, in viewport CSS pixels."},"element":{"anyOf":[{"$ref":"#/$defs/PreviewMarkElement"},{"type":"null"}],"description":"The element it landed on; `null` where it hit none."}},"required":["kind","number","note","point","element"],"description":"A numbered comment pin."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"box"},"number":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"Its number."},"note":{"type":["string","null"],"minLength":1,"maxLength":4096,"description":"The person's note; `null` where they wrote none."},"rect":{"$ref":"#/$defs/PreviewRect","description":"The box."},"element":{"anyOf":[{"$ref":"#/$defs/PreviewMarkElement"},{"type":"null"}],"description":"The element it landed on; `null` where it hit none."}},"required":["kind","number","note","rect","element"],"description":"A numbered box."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"stroke"},"points":{"type":"array","items":{"$ref":"#/$defs/PreviewPoint"},"minItems":1,"description":"Its points in viewport CSS pixels, at least one."},"color":{"$ref":"sidekicks-contracts:color#/$defs/HexColor","description":"Its sRGB color."},"element":{"anyOf":[{"$ref":"#/$defs/PreviewMarkElement"},{"type":"null"}],"description":"The element it landed on; `null` where it hit none."}},"required":["kind","points","color","element"],"description":"An unnumbered freehand stroke."}],"description":"One mark on the frozen picture, tagged on `kind`: a numbered comment pin, a numbered box,\nor an unnumbered freehand stroke.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
function validate1306(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1306.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.elementRef === undefined) && (missing0 = "elementRef")) || ((data.box === undefined) && (missing0 = "box"))) || ((data.snapshotGeneration === undefined) && (missing0 = "snapshotGeneration"))){validate1306.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "elementRef") || (key0 === "box")) || (key0 === "snapshotGeneration"))){validate1306.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.elementRef !== undefined){let data0: any = data.elementRef;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) < 1){validate1306.errors = [{instancePath:instancePath+"/elementRef",schemaPath:"#/$defs/PreviewElementRef/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1306.errors = [{instancePath:instancePath+"/elementRef",schemaPath:"#/$defs/PreviewElementRef/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.box !== undefined){let data1: any = data.box;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(data1 && typeof data1 == "object" && !Array.isArray(data1)){let missing1: any;if(((((data1.x === undefined) && (missing1 = "x")) || ((data1.y === undefined) && (missing1 = "y"))) || ((data1.width === undefined) && (missing1 = "width"))) || ((data1.height === undefined) && (missing1 = "height"))){validate1306.errors = [{instancePath:instancePath+"/box",schemaPath:"#/$defs/PreviewRect/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data1){if(!((((key1 === "x") || (key1 === "y")) || (key1 === "width")) || (key1 === "height"))){validate1306.errors = [{instancePath:instancePath+"/box",schemaPath:"#/$defs/PreviewRect/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data1.x !== undefined){let data2: any = data1.x;const _errs10: any = errors;if(!((typeof data2 == "number") && (isFinite(data2)))){validate1306.errors = [{instancePath:instancePath+"/box/x",schemaPath:"#/$defs/PreviewRect/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid3: any = _errs10 === errors;}else {var valid3: any = true;}if(valid3){if(data1.y !== undefined){let data3: any = data1.y;const _errs12: any = errors;if(!((typeof data3 == "number") && (isFinite(data3)))){validate1306.errors = [{instancePath:instancePath+"/box/y",schemaPath:"#/$defs/PreviewRect/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid3: any = _errs12 === errors;}else {var valid3: any = true;}if(valid3){if(data1.width !== undefined){let data4: any = data1.width;const _errs14: any = errors;if(errors === _errs14){if((typeof data4 == "number") && (isFinite(data4))){if(data4 < 0 || isNaN(data4)){validate1306.errors = [{instancePath:instancePath+"/box/width",schemaPath:"#/$defs/PreviewRect/properties/width/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}else {validate1306.errors = [{instancePath:instancePath+"/box/width",schemaPath:"#/$defs/PreviewRect/properties/width/type",keyword:"type",params:{type: "number"}}];return false;}}var valid3: any = _errs14 === errors;}else {var valid3: any = true;}if(valid3){if(data1.height !== undefined){let data5: any = data1.height;const _errs16: any = errors;if(errors === _errs16){if((typeof data5 == "number") && (isFinite(data5))){if(data5 < 0 || isNaN(data5)){validate1306.errors = [{instancePath:instancePath+"/box/height",schemaPath:"#/$defs/PreviewRect/properties/height/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}else {validate1306.errors = [{instancePath:instancePath+"/box/height",schemaPath:"#/$defs/PreviewRect/properties/height/type",keyword:"type",params:{type: "number"}}];return false;}}var valid3: any = _errs16 === errors;}else {var valid3: any = true;}}}}}}}else {validate1306.errors = [{instancePath:instancePath+"/box",schemaPath:"#/$defs/PreviewRect/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.snapshotGeneration !== undefined){let data6: any = data.snapshotGeneration;const _errs18: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate1306.errors = [{instancePath:instancePath+"/snapshotGeneration",schemaPath:"#/properties/snapshotGeneration/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs18){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validate1306.errors = [{instancePath:instancePath+"/snapshotGeneration",schemaPath:"#/properties/snapshotGeneration/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validate1306.errors = [{instancePath:instancePath+"/snapshotGeneration",schemaPath:"#/properties/snapshotGeneration/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}}}}}}else {validate1306.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1306.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1306.errors = null as any[] | null;
// prettier-ignore
validate1306.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern353 = new RegExp("^#[0-9a-fA-F]{6}$", "u");
// prettier-ignore
function validate1305(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1305.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "comment"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.kind === undefined) && (missing0 = "kind")) || ((data.number === undefined) && (missing0 = "number"))) || ((data.note === undefined) && (missing0 = "note"))) || ((data.point === undefined) && (missing0 = "point"))) || ((data.element === undefined) && (missing0 = "element"))){validate1305.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((key0 === "kind") || (key0 === "number")) || (key0 === "note")) || (key0 === "point")) || (key0 === "element"))){validate1305.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validate1305.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("comment" !== data0){validate1305.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "comment"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.number !== undefined){let data1: any = data.number;const _errs7: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1305.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/0/properties/number/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1305.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/0/properties/number/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate1305.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/0/properties/number/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.note !== undefined){let data2: any = data.note;const _errs9: any = errors;if((typeof data2 !== "string") && (data2 !== null)){validate1305.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/0/properties/note/type",keyword:"type",params:{type: schema2430.oneOf[0].properties.note.type}}];return false;}if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) > 4096){validate1305.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/0/properties/note/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validate1305.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/0/properties/note/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.point !== undefined){let data3: any = data.point;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing1: any;if(((data3.x === undefined) && (missing1 = "x")) || ((data3.y === undefined) && (missing1 = "y"))){validate1305.errors = [{instancePath:instancePath+"/point",schemaPath:"#/$defs/PreviewPoint/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data3){if(!((key1 === "x") || (key1 === "y"))){validate1305.errors = [{instancePath:instancePath+"/point",schemaPath:"#/$defs/PreviewPoint/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data3.x !== undefined){let data4: any = data3.x;const _errs15: any = errors;if(!((typeof data4 == "number") && (isFinite(data4)))){validate1305.errors = [{instancePath:instancePath+"/point/x",schemaPath:"#/$defs/PreviewPoint/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data3.y !== undefined){let data5: any = data3.y;const _errs17: any = errors;if(!((typeof data5 == "number") && (isFinite(data5)))){validate1305.errors = [{instancePath:instancePath+"/point/y",schemaPath:"#/$defs/PreviewPoint/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid4: any = _errs17 === errors;}else {var valid4: any = true;}}}}}else {validate1305.errors = [{instancePath:instancePath+"/point",schemaPath:"#/$defs/PreviewPoint/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.element !== undefined){let data6: any = data.element;const _errs19: any = errors;const _errs20: any = errors;let valid5: any = false;const _errs21: any = errors;if(!(validate1306.call(this, data6, {instancePath:instancePath+"/element",parentData:data,parentDataProperty:"element",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1306.errors : vErrors.concat(validate1306.errors);errors = vErrors.length;}var _valid0: any = _errs21 === errors;valid5 = valid5 || _valid0;const _errs22: any = errors;if(data6 !== null){const err0: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/0/properties/element/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs22 === errors;valid5 = valid5 || _valid0;if(!valid5){const err1: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/0/properties/element/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validate1305.errors = vErrors;return false;}else {errors = _errs20;if(vErrors !== null){if(_errs20){vErrors.length = _errs20;}else {vErrors = null;}}}var valid2: any = _errs19 === errors;}else {var valid2: any = true;}}}}}}}}else {validate1305.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props1: any = true;valid0 = valid1;}else if(tag0 === "box"){const _errs24: any = errors;if(errors === _errs24){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((((data.kind === undefined) && (missing2 = "kind")) || ((data.number === undefined) && (missing2 = "number"))) || ((data.note === undefined) && (missing2 = "note"))) || ((data.rect === undefined) && (missing2 = "rect"))) || ((data.element === undefined) && (missing2 = "element"))){validate1305.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs26: any = errors;for(const key2 in data){if(!(((((key2 === "kind") || (key2 === "number")) || (key2 === "note")) || (key2 === "rect")) || (key2 === "element"))){validate1305.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs26 === errors){if(data.kind !== undefined){let data7: any = data.kind;const _errs27: any = errors;if(typeof data7 !== "string"){validate1305.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("box" !== data7){validate1305.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "box"}}];return false;}var valid7: any = _errs27 === errors;}else {var valid7: any = true;}if(valid7){if(data.number !== undefined){let data8: any = data.number;const _errs29: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validate1305.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/1/properties/number/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs29){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validate1305.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/1/properties/number/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 1 || isNaN(data8)){validate1305.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/1/properties/number/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid7: any = _errs29 === errors;}else {var valid7: any = true;}if(valid7){if(data.note !== undefined){let data9: any = data.note;const _errs31: any = errors;if((typeof data9 !== "string") && (data9 !== null)){validate1305.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/1/properties/note/type",keyword:"type",params:{type: schema2430.oneOf[1].properties.note.type}}];return false;}if(errors === _errs31){if(typeof data9 === "string"){if(func1(data9) > 4096){validate1305.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/1/properties/note/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data9) < 1){validate1305.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/1/properties/note/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}}var valid7: any = _errs31 === errors;}else {var valid7: any = true;}if(valid7){if(data.rect !== undefined){let data10: any = data.rect;const _errs33: any = errors;const _errs34: any = errors;if(errors === _errs34){if(data10 && typeof data10 == "object" && !Array.isArray(data10)){let missing3: any;if(((((data10.x === undefined) && (missing3 = "x")) || ((data10.y === undefined) && (missing3 = "y"))) || ((data10.width === undefined) && (missing3 = "width"))) || ((data10.height === undefined) && (missing3 = "height"))){validate1305.errors = [{instancePath:instancePath+"/rect",schemaPath:"#/$defs/PreviewRect/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs36: any = errors;for(const key3 in data10){if(!((((key3 === "x") || (key3 === "y")) || (key3 === "width")) || (key3 === "height"))){validate1305.errors = [{instancePath:instancePath+"/rect",schemaPath:"#/$defs/PreviewRect/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs36 === errors){if(data10.x !== undefined){let data11: any = data10.x;const _errs37: any = errors;if(!((typeof data11 == "number") && (isFinite(data11)))){validate1305.errors = [{instancePath:instancePath+"/rect/x",schemaPath:"#/$defs/PreviewRect/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid9: any = _errs37 === errors;}else {var valid9: any = true;}if(valid9){if(data10.y !== undefined){let data12: any = data10.y;const _errs39: any = errors;if(!((typeof data12 == "number") && (isFinite(data12)))){validate1305.errors = [{instancePath:instancePath+"/rect/y",schemaPath:"#/$defs/PreviewRect/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid9: any = _errs39 === errors;}else {var valid9: any = true;}if(valid9){if(data10.width !== undefined){let data13: any = data10.width;const _errs41: any = errors;if(errors === _errs41){if((typeof data13 == "number") && (isFinite(data13))){if(data13 < 0 || isNaN(data13)){validate1305.errors = [{instancePath:instancePath+"/rect/width",schemaPath:"#/$defs/PreviewRect/properties/width/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}else {validate1305.errors = [{instancePath:instancePath+"/rect/width",schemaPath:"#/$defs/PreviewRect/properties/width/type",keyword:"type",params:{type: "number"}}];return false;}}var valid9: any = _errs41 === errors;}else {var valid9: any = true;}if(valid9){if(data10.height !== undefined){let data14: any = data10.height;const _errs43: any = errors;if(errors === _errs43){if((typeof data14 == "number") && (isFinite(data14))){if(data14 < 0 || isNaN(data14)){validate1305.errors = [{instancePath:instancePath+"/rect/height",schemaPath:"#/$defs/PreviewRect/properties/height/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}else {validate1305.errors = [{instancePath:instancePath+"/rect/height",schemaPath:"#/$defs/PreviewRect/properties/height/type",keyword:"type",params:{type: "number"}}];return false;}}var valid9: any = _errs43 === errors;}else {var valid9: any = true;}}}}}}}else {validate1305.errors = [{instancePath:instancePath+"/rect",schemaPath:"#/$defs/PreviewRect/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs33 === errors;}else {var valid7: any = true;}if(valid7){if(data.element !== undefined){let data15: any = data.element;const _errs45: any = errors;const _errs46: any = errors;let valid10: any = false;const _errs47: any = errors;if(!(validate1306.call(this, data15, {instancePath:instancePath+"/element",parentData:data,parentDataProperty:"element",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1306.errors : vErrors.concat(validate1306.errors);errors = vErrors.length;}var _valid1: any = _errs47 === errors;valid10 = valid10 || _valid1;const _errs48: any = errors;if(data15 !== null){const err2: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/1/properties/element/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid1: any = _errs48 === errors;valid10 = valid10 || _valid1;if(!valid10){const err3: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/1/properties/element/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate1305.errors = vErrors;return false;}else {errors = _errs46;if(vErrors !== null){if(_errs46){vErrors.length = _errs46;}else {vErrors = null;}}}var valid7: any = _errs45 === errors;}else {var valid7: any = true;}}}}}}}}else {validate1305.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs24 === errors;if(props1 !== true){props1 = true;}valid0 = valid6;}else if(tag0 === "stroke"){const _errs50: any = errors;if(errors === _errs50){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if(((((data.kind === undefined) && (missing4 = "kind")) || ((data.points === undefined) && (missing4 = "points"))) || ((data.color === undefined) && (missing4 = "color"))) || ((data.element === undefined) && (missing4 = "element"))){validate1305.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs52: any = errors;for(const key4 in data){if(!((((key4 === "kind") || (key4 === "points")) || (key4 === "color")) || (key4 === "element"))){validate1305.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs52 === errors){if(data.kind !== undefined){let data16: any = data.kind;const _errs53: any = errors;if(typeof data16 !== "string"){validate1305.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("stroke" !== data16){validate1305.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "stroke"}}];return false;}var valid12: any = _errs53 === errors;}else {var valid12: any = true;}if(valid12){if(data.points !== undefined){let data17: any = data.points;const _errs55: any = errors;if(errors === _errs55){if(Array.isArray(data17)){if(data17.length < 1){validate1305.errors = [{instancePath:instancePath+"/points",schemaPath:"#/oneOf/2/properties/points/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid13: any = true;const len0: any = data17.length;for(let i0=0; i0<len0; i0++){let data18: any = data17[i0];const _errs57: any = errors;const _errs58: any = errors;if(errors === _errs58){if(data18 && typeof data18 == "object" && !Array.isArray(data18)){let missing5: any;if(((data18.x === undefined) && (missing5 = "x")) || ((data18.y === undefined) && (missing5 = "y"))){validate1305.errors = [{instancePath:instancePath+"/points/" + i0,schemaPath:"#/$defs/PreviewPoint/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs60: any = errors;for(const key5 in data18){if(!((key5 === "x") || (key5 === "y"))){validate1305.errors = [{instancePath:instancePath+"/points/" + i0,schemaPath:"#/$defs/PreviewPoint/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs60 === errors){if(data18.x !== undefined){let data19: any = data18.x;const _errs61: any = errors;if(!((typeof data19 == "number") && (isFinite(data19)))){validate1305.errors = [{instancePath:instancePath+"/points/" + i0+"/x",schemaPath:"#/$defs/PreviewPoint/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid15: any = _errs61 === errors;}else {var valid15: any = true;}if(valid15){if(data18.y !== undefined){let data20: any = data18.y;const _errs63: any = errors;if(!((typeof data20 == "number") && (isFinite(data20)))){validate1305.errors = [{instancePath:instancePath+"/points/" + i0+"/y",schemaPath:"#/$defs/PreviewPoint/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid15: any = _errs63 === errors;}else {var valid15: any = true;}}}}}else {validate1305.errors = [{instancePath:instancePath+"/points/" + i0,schemaPath:"#/$defs/PreviewPoint/type",keyword:"type",params:{type: "object"}}];return false;}}var valid13: any = _errs57 === errors;if(!valid13){break;}}}}else {validate1305.errors = [{instancePath:instancePath+"/points",schemaPath:"#/oneOf/2/properties/points/type",keyword:"type",params:{type: "array"}}];return false;}}var valid12: any = _errs55 === errors;}else {var valid12: any = true;}if(valid12){if(data.color !== undefined){let data21: any = data.color;const _errs65: any = errors;const _errs66: any = errors;if(errors === _errs66){if(typeof data21 === "string"){if(!pattern353.test(data21)){validate1305.errors = [{instancePath:instancePath+"/color",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/pattern",keyword:"pattern",params:{pattern: "^#[0-9a-fA-F]{6}$"}}];return false;}}else {validate1305.errors = [{instancePath:instancePath+"/color",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs65 === errors;}else {var valid12: any = true;}if(valid12){if(data.element !== undefined){let data22: any = data.element;const _errs68: any = errors;const _errs69: any = errors;let valid17: any = false;const _errs70: any = errors;if(!(validate1306.call(this, data22, {instancePath:instancePath+"/element",parentData:data,parentDataProperty:"element",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1306.errors : vErrors.concat(validate1306.errors);errors = vErrors.length;}var _valid2: any = _errs70 === errors;valid17 = valid17 || _valid2;const _errs71: any = errors;if(data22 !== null){const err4: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/2/properties/element/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var _valid2: any = _errs71 === errors;valid17 = valid17 || _valid2;if(!valid17){const err5: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/2/properties/element/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate1305.errors = vErrors;return false;}else {errors = _errs69;if(vErrors !== null){if(_errs69){vErrors.length = _errs69;}else {vErrors = null;}}}var valid12: any = _errs68 === errors;}else {var valid12: any = true;}}}}}}}else {validate1305.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid11: any = _errs50 === errors;if(props1 !== true){props1 = true;}valid0 = valid11;}else {validate1305.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1305.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props1 !== true){for(const key6 in data){if(!props1 || !props1[key6]){validate1305.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key6}}];return false;break;}}}}}else {validate1305.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1305.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1305.errors = null as any[] | null;
// prettier-ignore
validate1305.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1304(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewMarkSendRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1304.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.image === undefined) && (missing0 = "image"))) || ((data.address === undefined) && (missing0 = "address"))) || ((data.width === undefined) && (missing0 = "width"))) || ((data.marks === undefined) && (missing0 = "marks"))){validate1304.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "image")) || (key0 === "address")) || (key0 === "width")) || (key0 === "marks"))){validate1304.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1304.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1304.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1304.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1304.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1304.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.image !== undefined){let data2: any = data.image;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if((data2.$bytes === undefined) && (missing1 = "$bytes")){validate1304.errors = [{instancePath:instancePath+"/image",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data2){if(!(key1 === "$bytes")){validate1304.errors = [{instancePath:instancePath+"/image",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data2.$bytes !== undefined){let data3: any = data2.$bytes;const _errs15: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1304.errors = [{instancePath:instancePath+"/image/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 4294967295 || isNaN(data3)){validate1304.errors = [{instancePath:instancePath+"/image/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1304.errors = [{instancePath:instancePath+"/image/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate1304.errors = [{instancePath:instancePath+"/image",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs11 === errors;if(valid3){if(!(data2 && typeof data2 == "object" && Number.isInteger(data2.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data2.$bytes] instanceof Uint8Array && this.attachments[data2.$bytes].byteLength >= 1)){validate1304.errors = [{instancePath:instancePath+"/image",schemaPath:"#/properties/image/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data2 && typeof data2 == "object" && Number.isInteger(data2.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data2.$bytes] instanceof Uint8Array && this.attachments[data2.$bytes].byteLength <= 4194300)){validate1304.errors = [{instancePath:instancePath+"/image",schemaPath:"#/properties/image/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.address !== undefined){let data4: any = data.address;const _errs18: any = errors;if(errors === _errs18){if(typeof data4 === "string"){if(func1(data4) > 2097152){validate1304.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data4) < 1){validate1304.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1304.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.width !== undefined){let data5: any = data.width;const _errs20: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate1304.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs20){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate1304.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 1 || isNaN(data5)){validate1304.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.marks !== undefined){let data6: any = data.marks;const _errs22: any = errors;if(errors === _errs22){if(Array.isArray(data6)){if(data6.length < 1){validate1304.errors = [{instancePath:instancePath+"/marks",schemaPath:"#/properties/marks/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid5: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){const _errs24: any = errors;if(!(validate1305.call(this, data6[i0], {instancePath:instancePath+"/marks/" + i0,parentData:data6,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1305.errors : vErrors.concat(validate1305.errors);errors = vErrors.length;}var valid5: any = _errs24 === errors;if(!valid5){break;}}}}else {validate1304.errors = [{instancePath:instancePath+"/marks",schemaPath:"#/properties/marks/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1304.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1304.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1304.errors = null as any[] | null;
// prettier-ignore
validate1304.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1313(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1313.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.artifactId === undefined) && (missing0 = "artifactId")) || ((data.fileName === undefined) && (missing0 = "fileName"))) || ((data.mimeType === undefined) && (missing0 = "mimeType"))) || ((data.sizeBytes === undefined) && (missing0 = "sizeBytes"))){validate1313.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "artifactId") || (key0 === "fileName")) || (key0 === "mimeType")) || (key0 === "sizeBytes"))){validate1313.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.artifactId !== undefined){let data0: any = data.artifactId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1313.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1313.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.fileName !== undefined){let data1: any = data.fileName;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1313.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1313.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1313.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/properties/fileName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.mimeType !== undefined){let data2: any = data.mimeType;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) < 1){validate1313.errors = [{instancePath:instancePath+"/mimeType",schemaPath:"#/properties/mimeType/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1313.errors = [{instancePath:instancePath+"/mimeType",schemaPath:"#/properties/mimeType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.sizeBytes !== undefined){let data3: any = data.sizeBytes;const _errs10: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1313.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1313.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1313.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}else {validate1313.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1313.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1313.errors = null as any[] | null;
// prettier-ignore
validate1313.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1311(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewMarkSendResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1311.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.staged === undefined) && (missing0 = "staged")){validate1311.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "staged")){validate1311.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.staged !== undefined){if(!(validate1313.call(this, data.staged, {instancePath:instancePath+"/staged",parentData:data,parentDataProperty:"staged",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1313.errors : vErrors.concat(validate1313.errors);errors = vErrors.length;}}}}}else {validate1311.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1311.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1311.errors = null as any[] | null;
// prettier-ignore
validate1311.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1315(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewMenuEditResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1315.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.applied === undefined) && (missing0 = "applied")){validate1315.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "applied")){validate1315.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.applied !== undefined){let data0: any = data.applied;if(typeof data0 !== "boolean"){validate1315.errors = [{instancePath:instancePath+"/applied",schemaPath:"#/properties/applied/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validate1315.errors = [{instancePath:instancePath+"/applied",schemaPath:"#/properties/applied/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validate1315.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1315.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1315.errors = null as any[] | null;
// prettier-ignore
validate1315.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2443: any = {"type":"object","additionalProperties":false,"properties":{"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"address":{"type":"string","minLength":1,"maxLength":2097152,"description":"Its address."},"host":{"type":"string","description":"Its host, shown in place of an empty `title`, so it is carried rather than re-parsed."},"title":{"type":"string","description":"The page's own title; may be empty."},"favicon":{"anyOf":[{"$ref":"#/$defs/PreviewFavicon"},{"type":"null"}],"description":"Its icon; `null` where it has none."},"loadState":{"$ref":"#/$defs/PreviewPageLoadState","description":"Where its load stands."},"backDepth":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How far its history reaches back; going back is possible above zero."},"forwardDepth":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How far its history reaches forward; going forward is possible above zero."},"zoomFactor":{"description":"Its own zoom, applied on the machine that runs it.","type":"number","enum":[0.5,0.6666666666666666,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2]},"released":{"type":"boolean","description":"The page's view was destroyed to free memory or by a restart; its address, order and zoom\nare kept, and it reloads when shown."}},"required":["pageId","address","host","title","favicon","loadState","backDepth","forwardDepth","zoomFactor","released"],"description":"One open page in a session's Preview pane."};
// prettier-ignore
const schema2447: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"loading"},"progress":{"type":["number","null"],"minimum":0,"maximum":1,"description":"The share loaded; `null` draws an indeterminate mark."}},"required":["kind","progress"],"description":"Loading."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"loaded"}},"required":["kind"],"description":"Loaded."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"failed"}},"required":["kind"],"description":"Failed."}],"description":"Where a page's load stands, tagged on `kind`: loading, with the fraction the engine reports or\n`null` when it reports none; loaded; or failed, which the pane reads as `<host> did not answer.`\nwith a try-again.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const pattern1692 = new RegExp("^image/[a-z0-9.+-]+$", "u");
// prettier-ignore
function validate1317(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1317.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.mediaType === undefined) && (missing0 = "mediaType")) || ((data.data === undefined) && (missing0 = "data"))){validate1317.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "mediaType") || (key0 === "data"))){validate1317.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.mediaType !== undefined){let data0: any = data.mediaType;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(!pattern1692.test(data0)){validate1317.errors = [{instancePath:instancePath+"/mediaType",schemaPath:"#/properties/mediaType/pattern",keyword:"pattern",params:{pattern: "^image/[a-z0-9.+-]+$"}}];return false;}}else {validate1317.errors = [{instancePath:instancePath+"/mediaType",schemaPath:"#/properties/mediaType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.data !== undefined){let data1: any = data.data;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(data1 && typeof data1 == "object" && !Array.isArray(data1)){let missing1: any;if((data1.$bytes === undefined) && (missing1 = "$bytes")){validate1317.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs8: any = errors;for(const key1 in data1){if(!(key1 === "$bytes")){validate1317.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs8 === errors){if(data1.$bytes !== undefined){let data2: any = data1.$bytes;const _errs9: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1317.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 4294967295 || isNaN(data2)){validate1317.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1317.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate1317.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs5 === errors;if(valid1){if(!(data1 && typeof data1 == "object" && Number.isInteger(data1.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data1.$bytes] instanceof Uint8Array && this.attachments[data1.$bytes].byteLength >= 1)){validate1317.errors = [{instancePath:instancePath+"/data",schemaPath:"#/properties/data/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data1 && typeof data1 == "object" && Number.isInteger(data1.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data1.$bytes] instanceof Uint8Array && this.attachments[data1.$bytes].byteLength <= 4194300)){validate1317.errors = [{instancePath:instancePath+"/data",schemaPath:"#/properties/data/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate1317.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1317.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1317.errors = null as any[] | null;
// prettier-ignore
validate1317.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1316(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPage {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1316.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.address === undefined) && (missing0 = "address"))) || ((data.host === undefined) && (missing0 = "host"))) || ((data.title === undefined) && (missing0 = "title"))) || ((data.favicon === undefined) && (missing0 = "favicon"))) || ((data.loadState === undefined) && (missing0 = "loadState"))) || ((data.backDepth === undefined) && (missing0 = "backDepth"))) || ((data.forwardDepth === undefined) && (missing0 = "forwardDepth"))) || ((data.zoomFactor === undefined) && (missing0 = "zoomFactor"))) || ((data.released === undefined) && (missing0 = "released"))){validate1316.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema2443.properties, key0))){validate1316.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){let data0: any = data.pageId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1316.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1316.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1316.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.address !== undefined){let data1: any = data.address;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 2097152){validate1316.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validate1316.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1316.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.host !== undefined){const _errs8: any = errors;if(typeof data.host !== "string"){validate1316.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.title !== undefined){const _errs10: any = errors;if(typeof data.title !== "string"){validate1316.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.favicon !== undefined){let data4: any = data.favicon;const _errs12: any = errors;const _errs13: any = errors;let valid2: any = false;const _errs14: any = errors;if(!(validate1317.call(this, data4, {instancePath:instancePath+"/favicon",parentData:data,parentDataProperty:"favicon",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1317.errors : vErrors.concat(validate1317.errors);errors = vErrors.length;}var _valid0: any = _errs14 === errors;valid2 = valid2 || _valid0;const _errs15: any = errors;if(data4 !== null){const err0: any = {instancePath:instancePath+"/favicon",schemaPath:"#/properties/favicon/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs15 === errors;valid2 = valid2 || _valid0;if(!valid2){const err1: any = {instancePath:instancePath+"/favicon",schemaPath:"#/properties/favicon/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validate1316.errors = vErrors;return false;}else {errors = _errs13;if(vErrors !== null){if(_errs13){vErrors.length = _errs13;}else {vErrors = null;}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.loadState !== undefined){let data5: any = data.loadState;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(data5 && typeof data5 == "object" && !Array.isArray(data5)){let valid4: any = false;const tag0: any = data5.kind;if(typeof tag0 == "string"){if(tag0 === "loading"){const _errs21: any = errors;if(errors === _errs21){if(data5 && typeof data5 == "object" && !Array.isArray(data5)){let missing1: any;if(((data5.kind === undefined) && (missing1 = "kind")) || ((data5.progress === undefined) && (missing1 = "progress"))){validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs23: any = errors;for(const key1 in data5){if(!((key1 === "kind") || (key1 === "progress"))){validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs23 === errors){if(data5.kind !== undefined){let data6: any = data5.kind;const _errs24: any = errors;if(typeof data6 !== "string"){validate1316.errors = [{instancePath:instancePath+"/loadState/kind",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("loading" !== data6){validate1316.errors = [{instancePath:instancePath+"/loadState/kind",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "loading"}}];return false;}var valid6: any = _errs24 === errors;}else {var valid6: any = true;}if(valid6){if(data5.progress !== undefined){let data7: any = data5.progress;const _errs26: any = errors;if((!((typeof data7 == "number") && (isFinite(data7)))) && (data7 !== null)){validate1316.errors = [{instancePath:instancePath+"/loadState/progress",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/0/properties/progress/type",keyword:"type",params:{type: schema2447.oneOf[0].properties.progress.type}}];return false;}if(errors === _errs26){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 1 || isNaN(data7)){validate1316.errors = [{instancePath:instancePath+"/loadState/progress",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/0/properties/progress/maximum",keyword:"maximum",params:{comparison: "<=", limit: 1}}];return false;}else {if(data7 < 0 || isNaN(data7)){validate1316.errors = [{instancePath:instancePath+"/loadState/progress",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/0/properties/progress/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid6: any = _errs26 === errors;}else {var valid6: any = true;}}}}}else {validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs21 === errors;var props1: any = true;valid4 = valid5;}else if(tag0 === "loaded"){const _errs28: any = errors;if(errors === _errs28){if(data5 && typeof data5 == "object" && !Array.isArray(data5)){let missing2: any;if((data5.kind === undefined) && (missing2 = "kind")){validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs30: any = errors;for(const key2 in data5){if(!(key2 === "kind")){validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs30 === errors){if(data5.kind !== undefined){let data8: any = data5.kind;if(typeof data8 !== "string"){validate1316.errors = [{instancePath:instancePath+"/loadState/kind",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("loaded" !== data8){validate1316.errors = [{instancePath:instancePath+"/loadState/kind",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "loaded"}}];return false;}}}}}else {validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs28 === errors;if(props1 !== true){props1 = true;}valid4 = valid7;}else if(tag0 === "failed"){const _errs33: any = errors;if(errors === _errs33){if(data5 && typeof data5 == "object" && !Array.isArray(data5)){let missing3: any;if((data5.kind === undefined) && (missing3 = "kind")){validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/2/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs35: any = errors;for(const key3 in data5){if(!(key3 === "kind")){validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs35 === errors){if(data5.kind !== undefined){let data9: any = data5.kind;if(typeof data9 !== "string"){validate1316.errors = [{instancePath:instancePath+"/loadState/kind",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data9){validate1316.errors = [{instancePath:instancePath+"/loadState/kind",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}}}}}else {validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs33 === errors;if(props1 !== true){props1 = true;}valid4 = valid9;}else {validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid4){if(props1 !== true){for(const key4 in data5){if(!props1 || !props1[key4]){validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key4}}];return false;break;}}}}}else {validate1316.errors = [{instancePath:instancePath+"/loadState",schemaPath:"#/$defs/PreviewPageLoadState/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}if(valid0){if(data.backDepth !== undefined){let data10: any = data.backDepth;const _errs39: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validate1316.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs39){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 9007199254740991 || isNaN(data10)){validate1316.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data10 < 0 || isNaN(data10)){validate1316.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs39 === errors;}else {var valid0: any = true;}if(valid0){if(data.forwardDepth !== undefined){let data11: any = data.forwardDepth;const _errs41: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){validate1316.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs41){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){validate1316.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data11 < 0 || isNaN(data11)){validate1316.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs41 === errors;}else {var valid0: any = true;}if(valid0){if(data.zoomFactor !== undefined){let data12: any = data.zoomFactor;const _errs43: any = errors;if(!((typeof data12 == "number") && (isFinite(data12)))){validate1316.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/type",keyword:"type",params:{type: "number"}}];return false;}if(!(((((((((((data12 === 0.5) || (data12 === 0.6666666666666666)) || (data12 === 0.75)) || (data12 === 0.8)) || (data12 === 0.9)) || (data12 === 1)) || (data12 === 1.1)) || (data12 === 1.25)) || (data12 === 1.5)) || (data12 === 1.75)) || (data12 === 2))){validate1316.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/enum",keyword:"enum",params:{allowedValues: schema2443.properties.zoomFactor.enum}}];return false;}var valid0: any = _errs43 === errors;}else {var valid0: any = true;}if(valid0){if(data.released !== undefined){const _errs45: any = errors;if(typeof data.released !== "boolean"){validate1316.errors = [{instancePath:instancePath+"/released",schemaPath:"#/properties/released/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs45 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}else {validate1316.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1316.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1316.errors = null as any[] | null;
// prettier-ignore
validate1316.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1319(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageActivateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1319.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.activePageId === undefined) && (missing0 = "activePageId")){validate1319.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "activePageId")){validate1319.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.activePageId !== undefined){let data0: any = data.activePageId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1319.errors = [{instancePath:instancePath+"/activePageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1319.errors = [{instancePath:instancePath+"/activePageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1319.errors = [{instancePath:instancePath+"/activePageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1319.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1319.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1319.errors = null as any[] | null;
// prettier-ignore
validate1319.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1320(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCloseResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1320.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.closed === undefined) && (missing0 = "closed")){validate1320.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "closed")){validate1320.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.closed !== undefined){let data0: any = data.closed;if(typeof data0 !== "boolean"){validate1320.errors = [{instancePath:instancePath+"/closed",schemaPath:"#/properties/closed/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validate1320.errors = [{instancePath:instancePath+"/closed",schemaPath:"#/properties/closed/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validate1320.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1320.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1320.errors = null as any[] | null;
// prettier-ignore
validate1320.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1321(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1321.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validate1321.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validate1321.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1321.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1321.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1321.errors = null as any[] | null;
// prettier-ignore
validate1321.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1322(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageListFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1322.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.pages === undefined) && (missing0 = "pages")) || ((data.activeIndex === undefined) && (missing0 = "activeIndex"))){validate1322.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "pages") || (key0 === "activeIndex"))){validate1322.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pages !== undefined){let data0: any = data.pages;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1316.call(this, data0[i0], {instancePath:instancePath+"/pages/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1316.errors : vErrors.concat(validate1316.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1322.errors = [{instancePath:instancePath+"/pages",schemaPath:"#/properties/pages/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.activeIndex !== undefined){let data2: any = data.activeIndex;const _errs5: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1322.errors = [{instancePath:instancePath+"/activeIndex",schemaPath:"#/properties/activeIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1322.errors = [{instancePath:instancePath+"/activeIndex",schemaPath:"#/properties/activeIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < -1 || isNaN(data2)){validate1322.errors = [{instancePath:instancePath+"/activeIndex",schemaPath:"#/properties/activeIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: -1}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate1322.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1322.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1322.errors = null as any[] | null;
// prettier-ignore
validate1322.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1324(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageNavigateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1324.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.to === undefined) && (missing0 = "to"))){validate1324.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "to"))){validate1324.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1324.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1324.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1324.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1324.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1324.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.to !== undefined){let data2: any = data.to;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let valid4: any = false;const tag0: any = data2.kind;if(typeof tag0 == "string"){if(tag0 === "address"){const _errs14: any = errors;if(errors === _errs14){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if(((data2.kind === undefined) && (missing1 = "kind")) || ((data2.address === undefined) && (missing1 = "address"))){validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs16: any = errors;for(const key1 in data2){if(!((key1 === "kind") || (key1 === "address"))){validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs16 === errors){if(data2.kind !== undefined){let data3: any = data2.kind;const _errs17: any = errors;if(typeof data3 !== "string"){validate1324.errors = [{instancePath:instancePath+"/to/kind",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("address" !== data3){validate1324.errors = [{instancePath:instancePath+"/to/kind",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "address"}}];return false;}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}if(valid6){if(data2.address !== undefined){let data4: any = data2.address;const _errs19: any = errors;if(errors === _errs19){if(typeof data4 === "string"){if(func1(data4) > 2097152){validate1324.errors = [{instancePath:instancePath+"/to/address",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/0/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data4) < 1){validate1324.errors = [{instancePath:instancePath+"/to/address",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/0/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1324.errors = [{instancePath:instancePath+"/to/address",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/0/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs19 === errors;}else {var valid6: any = true;}}}}}else {validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs14 === errors;var props0: any = true;valid4 = valid5;}else if(tag0 === "back"){const _errs21: any = errors;if(errors === _errs21){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing2: any;if((data2.kind === undefined) && (missing2 = "kind")){validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs23: any = errors;for(const key2 in data2){if(!(key2 === "kind")){validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs23 === errors){if(data2.kind !== undefined){let data5: any = data2.kind;if(typeof data5 !== "string"){validate1324.errors = [{instancePath:instancePath+"/to/kind",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("back" !== data5){validate1324.errors = [{instancePath:instancePath+"/to/kind",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "back"}}];return false;}}}}}else {validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs21 === errors;if(props0 !== true){props0 = true;}valid4 = valid7;}else if(tag0 === "forward"){const _errs26: any = errors;if(errors === _errs26){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing3: any;if((data2.kind === undefined) && (missing3 = "kind")){validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/2/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs28: any = errors;for(const key3 in data2){if(!(key3 === "kind")){validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs28 === errors){if(data2.kind !== undefined){let data6: any = data2.kind;if(typeof data6 !== "string"){validate1324.errors = [{instancePath:instancePath+"/to/kind",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("forward" !== data6){validate1324.errors = [{instancePath:instancePath+"/to/kind",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "forward"}}];return false;}}}}}else {validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs26 === errors;if(props0 !== true){props0 = true;}valid4 = valid9;}else if(tag0 === "reload"){const _errs31: any = errors;if(errors === _errs31){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing4: any;if((data2.kind === undefined) && (missing4 = "kind")){validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/3/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs33: any = errors;for(const key4 in data2){if(!(key4 === "kind")){validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs33 === errors){if(data2.kind !== undefined){let data7: any = data2.kind;if(typeof data7 !== "string"){validate1324.errors = [{instancePath:instancePath+"/to/kind",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("reload" !== data7){validate1324.errors = [{instancePath:instancePath+"/to/kind",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "reload"}}];return false;}}}}}else {validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid11: any = _errs31 === errors;if(props0 !== true){props0 = true;}valid4 = valid11;}else {validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid4){if(props0 !== true){for(const key5 in data2){if(!props0 || !props0[key5]){validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key5}}];return false;break;}}}}}else {validate1324.errors = [{instancePath:instancePath+"/to",schemaPath:"#/$defs/PreviewNavigationTarget/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1324.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1324.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1324.errors = null as any[] | null;
// prettier-ignore
validate1324.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1325(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageNavigateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1325.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.address === undefined) && (missing0 = "address"))) || ((data.movedFrom === undefined) && (missing0 = "movedFrom"))) || ((data.backDepth === undefined) && (missing0 = "backDepth"))) || ((data.forwardDepth === undefined) && (missing0 = "forwardDepth"))){validate1325.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "pageId") || (key0 === "address")) || (key0 === "movedFrom")) || (key0 === "backDepth")) || (key0 === "forwardDepth"))){validate1325.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){let data0: any = data.pageId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1325.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1325.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1325.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.address !== undefined){let data1: any = data.address;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 2097152){validate1325.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validate1325.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1325.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.movedFrom !== undefined){let data2: any = data.movedFrom;const _errs8: any = errors;const _errs9: any = errors;let valid2: any = false;const _errs10: any = errors;const _errs11: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){const err0: any = {instancePath:instancePath+"/movedFrom",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(errors === _errs11){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 65535 || isNaN(data2)){const err1: any = {instancePath:instancePath+"/movedFrom",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/maximum",keyword:"maximum",params:{comparison: "<=", limit: 65535}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {if(data2 < 1 || isNaN(data2)){const err2: any = {instancePath:instancePath+"/movedFrom",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}}}var _valid0: any = _errs10 === errors;valid2 = valid2 || _valid0;const _errs13: any = errors;if(data2 !== null){const err3: any = {instancePath:instancePath+"/movedFrom",schemaPath:"#/properties/movedFrom/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs13 === errors;valid2 = valid2 || _valid0;if(!valid2){const err4: any = {instancePath:instancePath+"/movedFrom",schemaPath:"#/properties/movedFrom/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate1325.errors = vErrors;return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.backDepth !== undefined){let data3: any = data.backDepth;const _errs15: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1325.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1325.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1325.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.forwardDepth !== undefined){let data4: any = data.forwardDepth;const _errs17: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate1325.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs17){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate1325.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate1325.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1325.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1325.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1325.errors = null as any[] | null;
// prettier-ignore
validate1325.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1327(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1327.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "address"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.address === undefined) && (missing0 = "address"))){validate1327.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "kind") || (key0 === "address"))){validate1327.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validate1327.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("address" !== data0){validate1327.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "address"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.address !== undefined){let data1: any = data.address;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 2097152){validate1327.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validate1327.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1327.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validate1327.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "devServer"){const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.kind === undefined) && (missing1 = "kind")) || ((data.port === undefined) && (missing1 = "port"))){validate1327.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key1 in data){if(!((key1 === "kind") || (key1 === "port"))){validate1327.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs11 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs12: any = errors;if(typeof data2 !== "string"){validate1327.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("devServer" !== data2){validate1327.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "devServer"}}];return false;}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}if(valid4){if(data.port !== undefined){let data3: any = data.port;const _errs14: any = errors;const _errs15: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1327.errors = [{instancePath:instancePath+"/port",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 65535 || isNaN(data3)){validate1327.errors = [{instancePath:instancePath+"/port",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/maximum",keyword:"maximum",params:{comparison: "<=", limit: 65535}}];return false;}else {if(data3 < 1 || isNaN(data3)){validate1327.errors = [{instancePath:instancePath+"/port",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}}}}}else {validate1327.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs9 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validate1327.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1327.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validate1327.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validate1327.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1327.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1327.errors = null as any[] | null;
// prettier-ignore
validate1327.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1326(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageOpenRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1326.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.target === undefined) && (missing0 = "target"))){validate1326.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "target"))){validate1326.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1326.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1326.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.target !== undefined){const _errs6: any = errors;if(!(validate1327.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1327.errors : vErrors.concat(validate1327.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1326.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1326.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1326.errors = null as any[] | null;
// prettier-ignore
validate1326.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1329(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageOpenResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1329.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.address === undefined) && (missing0 = "address"))) || ((data.movedFrom === undefined) && (missing0 = "movedFrom"))){validate1329.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "pageId") || (key0 === "address")) || (key0 === "movedFrom")) || (key0 === "releasedPageId"))){validate1329.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){let data0: any = data.pageId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1329.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1329.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1329.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.address !== undefined){let data1: any = data.address;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 2097152){validate1329.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validate1329.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1329.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.movedFrom !== undefined){let data2: any = data.movedFrom;const _errs8: any = errors;const _errs9: any = errors;let valid2: any = false;const _errs10: any = errors;const _errs11: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){const err0: any = {instancePath:instancePath+"/movedFrom",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(errors === _errs11){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 65535 || isNaN(data2)){const err1: any = {instancePath:instancePath+"/movedFrom",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/maximum",keyword:"maximum",params:{comparison: "<=", limit: 65535}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {if(data2 < 1 || isNaN(data2)){const err2: any = {instancePath:instancePath+"/movedFrom",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Port/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}}}var _valid0: any = _errs10 === errors;valid2 = valid2 || _valid0;const _errs13: any = errors;if(data2 !== null){const err3: any = {instancePath:instancePath+"/movedFrom",schemaPath:"#/properties/movedFrom/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs13 === errors;valid2 = valid2 || _valid0;if(!valid2){const err4: any = {instancePath:instancePath+"/movedFrom",schemaPath:"#/properties/movedFrom/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate1329.errors = vErrors;return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.releasedPageId !== undefined){let data3: any = data.releasedPageId;const _errs15: any = errors;const _errs16: any = errors;if(errors === _errs16){if(typeof data3 === "string"){if(func1(data3) > 256){validate1329.errors = [{instancePath:instancePath+"/releasedPageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validate1329.errors = [{instancePath:instancePath+"/releasedPageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1329.errors = [{instancePath:instancePath+"/releasedPageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}}}}}}}else {validate1329.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1329.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1329.errors = null as any[] | null;
// prettier-ignore
validate1329.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1330(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageReorderRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1330.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.toIndex === undefined) && (missing0 = "toIndex"))){validate1330.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "toIndex"))){validate1330.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1330.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1330.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1330.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1330.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1330.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.toIndex !== undefined){let data2: any = data.toIndex;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1330.errors = [{instancePath:instancePath+"/toIndex",schemaPath:"#/properties/toIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1330.errors = [{instancePath:instancePath+"/toIndex",schemaPath:"#/properties/toIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1330.errors = [{instancePath:instancePath+"/toIndex",schemaPath:"#/properties/toIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1330.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1330.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1330.errors = null as any[] | null;
// prettier-ignore
validate1330.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1331(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageReorderResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1331.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.pageIds === undefined) && (missing0 = "pageIds")){validate1331.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "pageIds")){validate1331.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageIds !== undefined){let data0: any = data.pageIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) > 256){validate1331.errors = [{instancePath:instancePath+"/pageIds/" + i0,schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1331.errors = [{instancePath:instancePath+"/pageIds/" + i0,schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1331.errors = [{instancePath:instancePath+"/pageIds/" + i0,schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1331.errors = [{instancePath:instancePath+"/pageIds",schemaPath:"#/properties/pageIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1331.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1331.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1331.errors = null as any[] | null;
// prettier-ignore
validate1331.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1332(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1332.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))){validate1332.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "pageId"))){validate1332.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1332.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1332.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1332.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1332.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1332.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1332.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1332.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1332.errors = null as any[] | null;
// prettier-ignore
validate1332.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1333(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1333.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate1333.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate1333.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1333.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1333.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1333.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1333.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1333.errors = null as any[] | null;
// prettier-ignore
validate1333.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2478: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"zoomFactor":{"description":"The factor.","type":"number","enum":[0.5,0.6666666666666666,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2]}},"required":["sessionId","pageId","zoomFactor"],"description":"Sets one page's zoom on the machine that runs it, so the live picture carries the result. A new\npage starts at 1; each open page keeps its own factor."};
// prettier-ignore
function validate1334(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageZoomUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1334.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.zoomFactor === undefined) && (missing0 = "zoomFactor"))){validate1334.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "zoomFactor"))){validate1334.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1334.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1334.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1334.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1334.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1334.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.zoomFactor !== undefined){let data2: any = data.zoomFactor;const _errs10: any = errors;if(!((typeof data2 == "number") && (isFinite(data2)))){validate1334.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/type",keyword:"type",params:{type: "number"}}];return false;}if(!(((((((((((data2 === 0.5) || (data2 === 0.6666666666666666)) || (data2 === 0.75)) || (data2 === 0.8)) || (data2 === 0.9)) || (data2 === 1)) || (data2 === 1.1)) || (data2 === 1.25)) || (data2 === 1.5)) || (data2 === 1.75)) || (data2 === 2))){validate1334.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/enum",keyword:"enum",params:{allowedValues: schema2478.properties.zoomFactor.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1334.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1334.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1334.errors = null as any[] | null;
// prettier-ignore
validate1334.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2481: any = {"type":"object","additionalProperties":false,"properties":{"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"zoomFactor":{"description":"The factor.","type":"number","enum":[0.5,0.6666666666666666,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2]}},"required":["pageId","zoomFactor"],"description":"The factor the page now has."};
// prettier-ignore
function validate1335(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageZoomUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1335.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.pageId === undefined) && (missing0 = "pageId")) || ((data.zoomFactor === undefined) && (missing0 = "zoomFactor"))){validate1335.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "pageId") || (key0 === "zoomFactor"))){validate1335.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){let data0: any = data.pageId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1335.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1335.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1335.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.zoomFactor !== undefined){let data1: any = data.zoomFactor;const _errs6: any = errors;if(!((typeof data1 == "number") && (isFinite(data1)))){validate1335.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/type",keyword:"type",params:{type: "number"}}];return false;}if(!(((((((((((data1 === 0.5) || (data1 === 0.6666666666666666)) || (data1 === 0.75)) || (data1 === 0.8)) || (data1 === 0.9)) || (data1 === 1)) || (data1 === 1.1)) || (data1 === 1.25)) || (data1 === 1.5)) || (data1 === 1.75)) || (data1 === 2))){validate1335.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/enum",keyword:"enum",params:{allowedValues: schema2481.properties.zoomFactor.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1335.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1335.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1335.errors = null as any[] | null;
// prettier-ignore
validate1335.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1336(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewSaveId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1336.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validate1336.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validate1336.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1336.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1336.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1336.errors = null as any[] | null;
// prettier-ignore
validate1336.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1337(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastAcknowledgeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1337.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.ackToken === undefined) && (missing0 = "ackToken"))){validate1337.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "ackToken"))){validate1337.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1337.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1337.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1337.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1337.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1337.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.ackToken !== undefined){let data2: any = data.ackToken;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) < 1){validate1337.errors = [{instancePath:instancePath+"/ackToken",schemaPath:"#/$defs/PreviewScreencastAcknowledgmentToken/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1337.errors = [{instancePath:instancePath+"/ackToken",schemaPath:"#/$defs/PreviewScreencastAcknowledgmentToken/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1337.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1337.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1337.errors = null as any[] | null;
// prettier-ignore
validate1337.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1338(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastEditRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1338.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.messageId === undefined) && (missing0 = "messageId"))) || ((data.edit === undefined) && (missing0 = "edit"))){validate1338.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "messageId")) || (key0 === "edit"))){validate1338.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1338.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1338.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1338.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1338.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1338.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageId !== undefined){let data2: any = data.messageId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 256){validate1338.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate1338.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1338.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.edit !== undefined){let data3: any = data.edit;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let valid5: any = false;const tag0: any = data3.kind;if(typeof tag0 == "string"){if(tag0 === "paste"){const _errs18: any = errors;if(errors === _errs18){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing1: any;if(((data3.kind === undefined) && (missing1 = "kind")) || ((data3.text === undefined) && (missing1 = "text"))){validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs20: any = errors;for(const key1 in data3){if(!((key1 === "kind") || (key1 === "text"))){validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs20 === errors){if(data3.kind !== undefined){let data4: any = data3.kind;const _errs21: any = errors;if(typeof data4 !== "string"){validate1338.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("paste" !== data4){validate1338.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "paste"}}];return false;}var valid7: any = _errs21 === errors;}else {var valid7: any = true;}if(valid7){if(data3.text !== undefined){const _errs23: any = errors;if(typeof data3.text !== "string"){validate1338.errors = [{instancePath:instancePath+"/edit/text",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/0/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}var valid7: any = _errs23 === errors;}else {var valid7: any = true;}}}}}else {validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs18 === errors;var props0: any = true;valid5 = valid6;}else if(tag0 === "selectAll"){const _errs25: any = errors;if(errors === _errs25){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing2: any;if((data3.kind === undefined) && (missing2 = "kind")){validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs27: any = errors;for(const key2 in data3){if(!(key2 === "kind")){validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs27 === errors){if(data3.kind !== undefined){let data6: any = data3.kind;if(typeof data6 !== "string"){validate1338.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("selectAll" !== data6){validate1338.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "selectAll"}}];return false;}}}}}else {validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid8: any = _errs25 === errors;if(props0 !== true){props0 = true;}valid5 = valid8;}else if(tag0 === "cut"){const _errs30: any = errors;if(errors === _errs30){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing3: any;if((data3.kind === undefined) && (missing3 = "kind")){validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/2/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs32: any = errors;for(const key3 in data3){if(!(key3 === "kind")){validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs32 === errors){if(data3.kind !== undefined){let data7: any = data3.kind;if(typeof data7 !== "string"){validate1338.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("cut" !== data7){validate1338.errors = [{instancePath:instancePath+"/edit/kind",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "cut"}}];return false;}}}}}else {validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid10: any = _errs30 === errors;if(props0 !== true){props0 = true;}valid5 = valid10;}else {validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid5){if(props0 !== true){for(const key4 in data3){if(!props0 || !props0[key4]){validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key4}}];return false;break;}}}}}else {validate1338.errors = [{instancePath:instancePath+"/edit",schemaPath:"#/$defs/PreviewMenuEdit/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}else {validate1338.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1338.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1338.errors = null as any[] | null;
// prettier-ignore
validate1338.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2493: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"frame"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"imageData":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes","minBytes":1,"maxBytes":4194300,"tsType":"Uint8Array","description":"The JPEG."},"metadata":{"$ref":"#/$defs/PreviewScreencastFrameMetadata","description":"What maps its pixels back to the page."},"ackToken":{"$ref":"#/$defs/PreviewScreencastAcknowledgmentToken","description":"The token that acknowledges it."}},"required":["kind","pageId","imageData","metadata","ackToken"],"description":"One frame: a JPEG, what maps its pixels back to page coordinates, and the token the\nwatcher returns to acknowledge it. The stream sends the newest image once the last is\nacknowledged, so a slow watcher sees the page as it is now."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"menu"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"messageId":{"$ref":"#/$defs/PreviewInputMessageId","description":"The input that raised it."},"point":{"$ref":"#/$defs/PreviewPoint","description":"Where it opened, in frame pixels."},"linkUrl":{"type":"string","minLength":1,"maxLength":2097152,"description":"The link under the press."},"isEditable":{"type":"boolean","description":"Whether the press landed in a field that takes text, neither read-only nor\ndisabled."},"canCut":{"type":"boolean","description":"Whether the page allows a cut there."},"canCopy":{"type":"boolean","description":"Whether the page allows a copy there."},"selectionText":{"type":"string","description":"The selected text; absent where the page allows no copy, as in a password field."}},"required":["kind","pageId","messageId","point","isEditable","canCut","canCopy"],"description":"The page's right-click menu, sent when the page leaves a device's menu uncanceled."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"fileChooser"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"messageId":{"$ref":"#/$defs/PreviewInputMessageId","description":"The input that opened it."},"mode":{"$ref":"#/$defs/PreviewFileChooserMode","description":"What it lets the device pick."},"accept":{"type":"string","minLength":1,"description":"The input's own `accept`, or a picker's types where it excludes every other file,\nwhich the device's picker honors."}},"required":["kind","pageId","messageId","mode"],"description":"A file chooser or a File System Access picker a device's press or key opened; the\ndevice opens its own picker."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"save"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"messageId":{"$ref":"#/$defs/PreviewInputMessageId","description":"The press or key that started a download; absent for a picker's write."},"saveId":{"$ref":"#/$defs/PreviewSaveId","description":"The save."},"fileName":{"type":"string","minLength":1,"maxLength":4096,"description":"The file's name, which the device cleans as the daemon cleans a staged name."},"folderPath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file's path inside a folder the device picked."},"size":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Its size in bytes."},"isHeld":{"type":"boolean","description":"Whether it was held while the device was away; the device asks before saving it."}},"required":["kind","pageId","saveId","fileName","size","isHeld"],"description":"A file the page saved for this device: a download its press or key started, or a write\nthe page finished through a handle its picker gave. Its bytes follow as `savePart`\nelements, one save at a time; a save held while the device had no stream is sent again,\nwhole, when it opens Preview on the session again."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"savePart"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"saveId":{"$ref":"#/$defs/PreviewSaveId","description":"The save."},"part":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes","minBytes":1,"maxBytes":262144,"tsType":"Uint8Array","description":"This part's bytes."},"isLastPart":{"type":"boolean","description":"Whether the file ends with this part."}},"required":["kind","pageId","saveId","part","isLastPart"],"description":"One part of a save. A device that loses its stream before the last part throws the\nsave away."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"downloadRefused"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."}},"required":["kind","pageId"],"description":"A download on this page no person started, an agent's click or a workflow step; the\npane reads `Downloads are off in Preview`."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"saveCanceled"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"fileName":{"type":"string","minLength":1,"maxLength":4096,"description":"The file's name."}},"required":["kind","pageId","fileName"],"description":"A save canceled because staging it would leave the staging folder's volume under 2 GiB\nfree; the pane reads that the machine is low on disk space."}],"description":"One element of a page's live picture, tagged on `kind`. A menu, a file chooser and a\ndownload name the `messageId` of the device's input that raised them, so the device knows\nwhich of its presses each answers.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const schema2503: any = {"description":"What a file chooser lets the device pick.","type":"string","enum":["selectSingle","selectMultiple","selectFolder"]};
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate1339(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastElement {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1339.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "frame"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.kind === undefined) && (missing0 = "kind")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.imageData === undefined) && (missing0 = "imageData"))) || ((data.metadata === undefined) && (missing0 = "metadata"))) || ((data.ackToken === undefined) && (missing0 = "ackToken"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((key0 === "kind") || (key0 === "pageId")) || (key0 === "imageData")) || (key0 === "metadata")) || (key0 === "ackToken"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("frame" !== data0){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "frame"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(func1(data1) > 256){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.imageData !== undefined){let data2: any = data.imageData;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if((data2.$bytes === undefined) && (missing1 = "$bytes")){validate1339.errors = [{instancePath:instancePath+"/imageData",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs15: any = errors;for(const key1 in data2){if(!(key1 === "$bytes")){validate1339.errors = [{instancePath:instancePath+"/imageData",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs15 === errors){if(data2.$bytes !== undefined){let data3: any = data2.$bytes;const _errs16: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1339.errors = [{instancePath:instancePath+"/imageData/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs16){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 4294967295 || isNaN(data3)){validate1339.errors = [{instancePath:instancePath+"/imageData/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1339.errors = [{instancePath:instancePath+"/imageData/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate1339.errors = [{instancePath:instancePath+"/imageData",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs12 === errors;if(valid4){if(!(data2 && typeof data2 == "object" && Number.isInteger(data2.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data2.$bytes] instanceof Uint8Array && this.attachments[data2.$bytes].byteLength >= 1)){validate1339.errors = [{instancePath:instancePath+"/imageData",schemaPath:"#/oneOf/0/properties/imageData/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data2 && typeof data2 == "object" && Number.isInteger(data2.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data2.$bytes] instanceof Uint8Array && this.attachments[data2.$bytes].byteLength <= 4194300)){validate1339.errors = [{instancePath:instancePath+"/imageData",schemaPath:"#/oneOf/0/properties/imageData/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.metadata !== undefined){let data4: any = data.metadata;const _errs19: any = errors;const _errs20: any = errors;if(errors === _errs20){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){let missing2: any;if(((((((data4.offsetTop === undefined) && (missing2 = "offsetTop")) || ((data4.pageScaleFactor === undefined) && (missing2 = "pageScaleFactor"))) || ((data4.deviceWidth === undefined) && (missing2 = "deviceWidth"))) || ((data4.deviceHeight === undefined) && (missing2 = "deviceHeight"))) || ((data4.scrollOffsetX === undefined) && (missing2 = "scrollOffsetX"))) || ((data4.scrollOffsetY === undefined) && (missing2 = "scrollOffsetY"))){validate1339.errors = [{instancePath:instancePath+"/metadata",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs22: any = errors;for(const key2 in data4){if(!((((((key2 === "offsetTop") || (key2 === "pageScaleFactor")) || (key2 === "deviceWidth")) || (key2 === "deviceHeight")) || (key2 === "scrollOffsetX")) || (key2 === "scrollOffsetY"))){validate1339.errors = [{instancePath:instancePath+"/metadata",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs22 === errors){if(data4.offsetTop !== undefined){let data5: any = data4.offsetTop;const _errs23: any = errors;if(!((typeof data5 == "number") && (isFinite(data5)))){validate1339.errors = [{instancePath:instancePath+"/metadata/offsetTop",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/properties/offsetTop/type",keyword:"type",params:{type: "number"}}];return false;}var valid7: any = _errs23 === errors;}else {var valid7: any = true;}if(valid7){if(data4.pageScaleFactor !== undefined){let data6: any = data4.pageScaleFactor;const _errs25: any = errors;if(errors === _errs25){if((typeof data6 == "number") && (isFinite(data6))){if(data6 <= 0 || isNaN(data6)){validate1339.errors = [{instancePath:instancePath+"/metadata/pageScaleFactor",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/properties/pageScaleFactor/exclusiveMinimum",keyword:"exclusiveMinimum",params:{comparison: ">", limit: 0}}];return false;}}else {validate1339.errors = [{instancePath:instancePath+"/metadata/pageScaleFactor",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/properties/pageScaleFactor/type",keyword:"type",params:{type: "number"}}];return false;}}var valid7: any = _errs25 === errors;}else {var valid7: any = true;}if(valid7){if(data4.deviceWidth !== undefined){let data7: any = data4.deviceWidth;const _errs27: any = errors;if(errors === _errs27){if((typeof data7 == "number") && (isFinite(data7))){if(data7 < 0 || isNaN(data7)){validate1339.errors = [{instancePath:instancePath+"/metadata/deviceWidth",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/properties/deviceWidth/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}else {validate1339.errors = [{instancePath:instancePath+"/metadata/deviceWidth",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/properties/deviceWidth/type",keyword:"type",params:{type: "number"}}];return false;}}var valid7: any = _errs27 === errors;}else {var valid7: any = true;}if(valid7){if(data4.deviceHeight !== undefined){let data8: any = data4.deviceHeight;const _errs29: any = errors;if(errors === _errs29){if((typeof data8 == "number") && (isFinite(data8))){if(data8 < 0 || isNaN(data8)){validate1339.errors = [{instancePath:instancePath+"/metadata/deviceHeight",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/properties/deviceHeight/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}else {validate1339.errors = [{instancePath:instancePath+"/metadata/deviceHeight",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/properties/deviceHeight/type",keyword:"type",params:{type: "number"}}];return false;}}var valid7: any = _errs29 === errors;}else {var valid7: any = true;}if(valid7){if(data4.scrollOffsetX !== undefined){let data9: any = data4.scrollOffsetX;const _errs31: any = errors;if(!((typeof data9 == "number") && (isFinite(data9)))){validate1339.errors = [{instancePath:instancePath+"/metadata/scrollOffsetX",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/properties/scrollOffsetX/type",keyword:"type",params:{type: "number"}}];return false;}var valid7: any = _errs31 === errors;}else {var valid7: any = true;}if(valid7){if(data4.scrollOffsetY !== undefined){let data10: any = data4.scrollOffsetY;const _errs33: any = errors;if(!((typeof data10 == "number") && (isFinite(data10)))){validate1339.errors = [{instancePath:instancePath+"/metadata/scrollOffsetY",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/properties/scrollOffsetY/type",keyword:"type",params:{type: "number"}}];return false;}var valid7: any = _errs33 === errors;}else {var valid7: any = true;}}}}}}}}}else {validate1339.errors = [{instancePath:instancePath+"/metadata",schemaPath:"#/$defs/PreviewScreencastFrameMetadata/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs19 === errors;}else {var valid2: any = true;}if(valid2){if(data.ackToken !== undefined){let data11: any = data.ackToken;const _errs35: any = errors;const _errs36: any = errors;if(errors === _errs36){if(typeof data11 === "string"){if(func1(data11) < 1){validate1339.errors = [{instancePath:instancePath+"/ackToken",schemaPath:"#/$defs/PreviewScreencastAcknowledgmentToken/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1339.errors = [{instancePath:instancePath+"/ackToken",schemaPath:"#/$defs/PreviewScreencastAcknowledgmentToken/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs35 === errors;}else {var valid2: any = true;}}}}}}}}else {validate1339.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "menu"){const _errs39: any = errors;if(errors === _errs39){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((((((((data.kind === undefined) && (missing3 = "kind")) || ((data.pageId === undefined) && (missing3 = "pageId"))) || ((data.messageId === undefined) && (missing3 = "messageId"))) || ((data.point === undefined) && (missing3 = "point"))) || ((data.isEditable === undefined) && (missing3 = "isEditable"))) || ((data.canCut === undefined) && (missing3 = "canCut"))) || ((data.canCopy === undefined) && (missing3 = "canCopy"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs41: any = errors;for(const key3 in data){if(!(func2.call(schema2493.oneOf[1].properties, key3))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs41 === errors){if(data.kind !== undefined){let data12: any = data.kind;const _errs42: any = errors;if(typeof data12 !== "string"){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("menu" !== data12){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "menu"}}];return false;}var valid10: any = _errs42 === errors;}else {var valid10: any = true;}if(valid10){if(data.pageId !== undefined){let data13: any = data.pageId;const _errs44: any = errors;const _errs45: any = errors;if(errors === _errs45){if(typeof data13 === "string"){if(func1(data13) > 256){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data13) < 1){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs44 === errors;}else {var valid10: any = true;}if(valid10){if(data.messageId !== undefined){let data14: any = data.messageId;const _errs48: any = errors;const _errs49: any = errors;if(errors === _errs49){if(typeof data14 === "string"){if(func1(data14) > 256){validate1339.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data14) < 1){validate1339.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs48 === errors;}else {var valid10: any = true;}if(valid10){if(data.point !== undefined){let data15: any = data.point;const _errs52: any = errors;const _errs53: any = errors;if(errors === _errs53){if(data15 && typeof data15 == "object" && !Array.isArray(data15)){let missing4: any;if(((data15.x === undefined) && (missing4 = "x")) || ((data15.y === undefined) && (missing4 = "y"))){validate1339.errors = [{instancePath:instancePath+"/point",schemaPath:"#/$defs/PreviewPoint/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs55: any = errors;for(const key4 in data15){if(!((key4 === "x") || (key4 === "y"))){validate1339.errors = [{instancePath:instancePath+"/point",schemaPath:"#/$defs/PreviewPoint/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs55 === errors){if(data15.x !== undefined){let data16: any = data15.x;const _errs56: any = errors;if(!((typeof data16 == "number") && (isFinite(data16)))){validate1339.errors = [{instancePath:instancePath+"/point/x",schemaPath:"#/$defs/PreviewPoint/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid14: any = _errs56 === errors;}else {var valid14: any = true;}if(valid14){if(data15.y !== undefined){let data17: any = data15.y;const _errs58: any = errors;if(!((typeof data17 == "number") && (isFinite(data17)))){validate1339.errors = [{instancePath:instancePath+"/point/y",schemaPath:"#/$defs/PreviewPoint/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid14: any = _errs58 === errors;}else {var valid14: any = true;}}}}}else {validate1339.errors = [{instancePath:instancePath+"/point",schemaPath:"#/$defs/PreviewPoint/type",keyword:"type",params:{type: "object"}}];return false;}}var valid10: any = _errs52 === errors;}else {var valid10: any = true;}if(valid10){if(data.linkUrl !== undefined){let data18: any = data.linkUrl;const _errs60: any = errors;if(errors === _errs60){if(typeof data18 === "string"){if(func1(data18) > 2097152){validate1339.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/oneOf/1/properties/linkUrl/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data18) < 1){validate1339.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/oneOf/1/properties/linkUrl/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/oneOf/1/properties/linkUrl/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs60 === errors;}else {var valid10: any = true;}if(valid10){if(data.isEditable !== undefined){const _errs62: any = errors;if(typeof data.isEditable !== "boolean"){validate1339.errors = [{instancePath:instancePath+"/isEditable",schemaPath:"#/oneOf/1/properties/isEditable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid10: any = _errs62 === errors;}else {var valid10: any = true;}if(valid10){if(data.canCut !== undefined){const _errs64: any = errors;if(typeof data.canCut !== "boolean"){validate1339.errors = [{instancePath:instancePath+"/canCut",schemaPath:"#/oneOf/1/properties/canCut/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid10: any = _errs64 === errors;}else {var valid10: any = true;}if(valid10){if(data.canCopy !== undefined){const _errs66: any = errors;if(typeof data.canCopy !== "boolean"){validate1339.errors = [{instancePath:instancePath+"/canCopy",schemaPath:"#/oneOf/1/properties/canCopy/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid10: any = _errs66 === errors;}else {var valid10: any = true;}if(valid10){if(data.selectionText !== undefined){const _errs68: any = errors;if(typeof data.selectionText !== "string"){validate1339.errors = [{instancePath:instancePath+"/selectionText",schemaPath:"#/oneOf/1/properties/selectionText/type",keyword:"type",params:{type: "string"}}];return false;}var valid10: any = _errs68 === errors;}else {var valid10: any = true;}}}}}}}}}}}}else {validate1339.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs39 === errors;if(props0 !== true){props0 = true;}valid0 = valid9;}else if(tag0 === "fileChooser"){const _errs70: any = errors;if(errors === _errs70){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if(((((data.kind === undefined) && (missing5 = "kind")) || ((data.pageId === undefined) && (missing5 = "pageId"))) || ((data.messageId === undefined) && (missing5 = "messageId"))) || ((data.mode === undefined) && (missing5 = "mode"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs72: any = errors;for(const key5 in data){if(!(((((key5 === "kind") || (key5 === "pageId")) || (key5 === "messageId")) || (key5 === "mode")) || (key5 === "accept"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs72 === errors){if(data.kind !== undefined){let data23: any = data.kind;const _errs73: any = errors;if(typeof data23 !== "string"){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("fileChooser" !== data23){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "fileChooser"}}];return false;}var valid16: any = _errs73 === errors;}else {var valid16: any = true;}if(valid16){if(data.pageId !== undefined){let data24: any = data.pageId;const _errs75: any = errors;const _errs76: any = errors;if(errors === _errs76){if(typeof data24 === "string"){if(func1(data24) > 256){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data24) < 1){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid16: any = _errs75 === errors;}else {var valid16: any = true;}if(valid16){if(data.messageId !== undefined){let data25: any = data.messageId;const _errs79: any = errors;const _errs80: any = errors;if(errors === _errs80){if(typeof data25 === "string"){if(func1(data25) > 256){validate1339.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data25) < 1){validate1339.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid16: any = _errs79 === errors;}else {var valid16: any = true;}if(valid16){if(data.mode !== undefined){let data26: any = data.mode;const _errs83: any = errors;if(typeof data26 !== "string"){validate1339.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/PreviewFileChooserMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data26 === "selectSingle") || (data26 === "selectMultiple")) || (data26 === "selectFolder"))){validate1339.errors = [{instancePath:instancePath+"/mode",schemaPath:"#/$defs/PreviewFileChooserMode/enum",keyword:"enum",params:{allowedValues: schema2503.enum}}];return false;}var valid16: any = _errs83 === errors;}else {var valid16: any = true;}if(valid16){if(data.accept !== undefined){let data27: any = data.accept;const _errs86: any = errors;if(errors === _errs86){if(typeof data27 === "string"){if(func1(data27) < 1){validate1339.errors = [{instancePath:instancePath+"/accept",schemaPath:"#/oneOf/2/properties/accept/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1339.errors = [{instancePath:instancePath+"/accept",schemaPath:"#/oneOf/2/properties/accept/type",keyword:"type",params:{type: "string"}}];return false;}}var valid16: any = _errs86 === errors;}else {var valid16: any = true;}}}}}}}}else {validate1339.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid15: any = _errs70 === errors;if(props0 !== true){props0 = true;}valid0 = valid15;}else if(tag0 === "save"){const _errs88: any = errors;if(errors === _errs88){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if(((((((data.kind === undefined) && (missing6 = "kind")) || ((data.pageId === undefined) && (missing6 = "pageId"))) || ((data.saveId === undefined) && (missing6 = "saveId"))) || ((data.fileName === undefined) && (missing6 = "fileName"))) || ((data.size === undefined) && (missing6 = "size"))) || ((data.isHeld === undefined) && (missing6 = "isHeld"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs90: any = errors;for(const key6 in data){if(!((((((((key6 === "kind") || (key6 === "pageId")) || (key6 === "messageId")) || (key6 === "saveId")) || (key6 === "fileName")) || (key6 === "folderPath")) || (key6 === "size")) || (key6 === "isHeld"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs90 === errors){if(data.kind !== undefined){let data28: any = data.kind;const _errs91: any = errors;if(typeof data28 !== "string"){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("save" !== data28){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "save"}}];return false;}var valid21: any = _errs91 === errors;}else {var valid21: any = true;}if(valid21){if(data.pageId !== undefined){let data29: any = data.pageId;const _errs93: any = errors;const _errs94: any = errors;if(errors === _errs94){if(typeof data29 === "string"){if(func1(data29) > 256){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data29) < 1){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs93 === errors;}else {var valid21: any = true;}if(valid21){if(data.messageId !== undefined){let data30: any = data.messageId;const _errs97: any = errors;const _errs98: any = errors;if(errors === _errs98){if(typeof data30 === "string"){if(func1(data30) > 256){validate1339.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data30) < 1){validate1339.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs97 === errors;}else {var valid21: any = true;}if(valid21){if(data.saveId !== undefined){let data31: any = data.saveId;const _errs101: any = errors;const _errs102: any = errors;if(errors === _errs102){if(typeof data31 === "string"){if(func1(data31) > 256){validate1339.errors = [{instancePath:instancePath+"/saveId",schemaPath:"#/$defs/PreviewSaveId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data31) < 1){validate1339.errors = [{instancePath:instancePath+"/saveId",schemaPath:"#/$defs/PreviewSaveId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/saveId",schemaPath:"#/$defs/PreviewSaveId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs101 === errors;}else {var valid21: any = true;}if(valid21){if(data.fileName !== undefined){let data32: any = data.fileName;const _errs105: any = errors;if(errors === _errs105){if(typeof data32 === "string"){if(func1(data32) > 4096){validate1339.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/3/properties/fileName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data32) < 1){validate1339.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/3/properties/fileName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/3/properties/fileName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs105 === errors;}else {var valid21: any = true;}if(valid21){if(data.folderPath !== undefined){let data33: any = data.folderPath;const _errs107: any = errors;if(errors === _errs107){if(typeof data33 === "string"){if(func1(data33) > 4096){validate1339.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/oneOf/3/properties/folderPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data33) < 1){validate1339.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/oneOf/3/properties/folderPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data33)){validate1339.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/oneOf/3/properties/folderPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1339.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/oneOf/3/properties/folderPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs107 === errors;}else {var valid21: any = true;}if(valid21){if(data.size !== undefined){let data34: any = data.size;const _errs109: any = errors;if(!(((typeof data34 == "number") && (!(data34 % 1) && !isNaN(data34))) && (isFinite(data34)))){validate1339.errors = [{instancePath:instancePath+"/size",schemaPath:"#/oneOf/3/properties/size/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs109){if((typeof data34 == "number") && (isFinite(data34))){if(data34 > 9007199254740991 || isNaN(data34)){validate1339.errors = [{instancePath:instancePath+"/size",schemaPath:"#/oneOf/3/properties/size/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data34 < 0 || isNaN(data34)){validate1339.errors = [{instancePath:instancePath+"/size",schemaPath:"#/oneOf/3/properties/size/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid21: any = _errs109 === errors;}else {var valid21: any = true;}if(valid21){if(data.isHeld !== undefined){const _errs111: any = errors;if(typeof data.isHeld !== "boolean"){validate1339.errors = [{instancePath:instancePath+"/isHeld",schemaPath:"#/oneOf/3/properties/isHeld/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid21: any = _errs111 === errors;}else {var valid21: any = true;}}}}}}}}}}}else {validate1339.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid20: any = _errs88 === errors;if(props0 !== true){props0 = true;}valid0 = valid20;}else if(tag0 === "savePart"){const _errs113: any = errors;if(errors === _errs113){if(data && typeof data == "object" && !Array.isArray(data)){let missing7: any;if((((((data.kind === undefined) && (missing7 = "kind")) || ((data.pageId === undefined) && (missing7 = "pageId"))) || ((data.saveId === undefined) && (missing7 = "saveId"))) || ((data.part === undefined) && (missing7 = "part"))) || ((data.isLastPart === undefined) && (missing7 = "isLastPart"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing7}}];return false;}else {const _errs115: any = errors;for(const key7 in data){if(!(((((key7 === "kind") || (key7 === "pageId")) || (key7 === "saveId")) || (key7 === "part")) || (key7 === "isLastPart"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7}}];return false;break;}}if(_errs115 === errors){if(data.kind !== undefined){let data36: any = data.kind;const _errs116: any = errors;if(typeof data36 !== "string"){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("savePart" !== data36){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "savePart"}}];return false;}var valid26: any = _errs116 === errors;}else {var valid26: any = true;}if(valid26){if(data.pageId !== undefined){let data37: any = data.pageId;const _errs118: any = errors;const _errs119: any = errors;if(errors === _errs119){if(typeof data37 === "string"){if(func1(data37) > 256){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data37) < 1){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid26: any = _errs118 === errors;}else {var valid26: any = true;}if(valid26){if(data.saveId !== undefined){let data38: any = data.saveId;const _errs122: any = errors;const _errs123: any = errors;if(errors === _errs123){if(typeof data38 === "string"){if(func1(data38) > 256){validate1339.errors = [{instancePath:instancePath+"/saveId",schemaPath:"#/$defs/PreviewSaveId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data38) < 1){validate1339.errors = [{instancePath:instancePath+"/saveId",schemaPath:"#/$defs/PreviewSaveId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/saveId",schemaPath:"#/$defs/PreviewSaveId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid26: any = _errs122 === errors;}else {var valid26: any = true;}if(valid26){if(data.part !== undefined){let data39: any = data.part;const _errs126: any = errors;const _errs127: any = errors;if(errors === _errs127){if(data39 && typeof data39 == "object" && !Array.isArray(data39)){let missing8: any;if((data39.$bytes === undefined) && (missing8 = "$bytes")){validate1339.errors = [{instancePath:instancePath+"/part",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/required",keyword:"required",params:{missingProperty: missing8}}];return false;}else {const _errs130: any = errors;for(const key8 in data39){if(!(key8 === "$bytes")){validate1339.errors = [{instancePath:instancePath+"/part",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key8}}];return false;break;}}if(_errs130 === errors){if(data39.$bytes !== undefined){let data40: any = data39.$bytes;const _errs131: any = errors;if(!(((typeof data40 == "number") && (!(data40 % 1) && !isNaN(data40))) && (isFinite(data40)))){validate1339.errors = [{instancePath:instancePath+"/part/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs131){if((typeof data40 == "number") && (isFinite(data40))){if(data40 > 4294967295 || isNaN(data40)){validate1339.errors = [{instancePath:instancePath+"/part/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295}}];return false;}else {if(data40 < 0 || isNaN(data40)){validate1339.errors = [{instancePath:instancePath+"/part/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate1339.errors = [{instancePath:instancePath+"/part",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/type",keyword:"type",params:{type: "object"}}];return false;}}var valid29: any = _errs127 === errors;if(valid29){if(!(data39 && typeof data39 == "object" && Number.isInteger(data39.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data39.$bytes] instanceof Uint8Array && this.attachments[data39.$bytes].byteLength >= 1)){validate1339.errors = [{instancePath:instancePath+"/part",schemaPath:"#/oneOf/4/properties/part/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data39 && typeof data39 == "object" && Number.isInteger(data39.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data39.$bytes] instanceof Uint8Array && this.attachments[data39.$bytes].byteLength <= 262144)){validate1339.errors = [{instancePath:instancePath+"/part",schemaPath:"#/oneOf/4/properties/part/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid26: any = _errs126 === errors;}else {var valid26: any = true;}if(valid26){if(data.isLastPart !== undefined){const _errs134: any = errors;if(typeof data.isLastPart !== "boolean"){validate1339.errors = [{instancePath:instancePath+"/isLastPart",schemaPath:"#/oneOf/4/properties/isLastPart/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid26: any = _errs134 === errors;}else {var valid26: any = true;}}}}}}}}else {validate1339.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid25: any = _errs113 === errors;if(props0 !== true){props0 = true;}valid0 = valid25;}else if(tag0 === "downloadRefused"){const _errs136: any = errors;if(errors === _errs136){if(data && typeof data == "object" && !Array.isArray(data)){let missing9: any;if(((data.kind === undefined) && (missing9 = "kind")) || ((data.pageId === undefined) && (missing9 = "pageId"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing9}}];return false;}else {const _errs138: any = errors;for(const key9 in data){if(!((key9 === "kind") || (key9 === "pageId"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key9}}];return false;break;}}if(_errs138 === errors){if(data.kind !== undefined){let data42: any = data.kind;const _errs139: any = errors;if(typeof data42 !== "string"){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("downloadRefused" !== data42){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/const",keyword:"const",params:{allowedValue: "downloadRefused"}}];return false;}var valid32: any = _errs139 === errors;}else {var valid32: any = true;}if(valid32){if(data.pageId !== undefined){let data43: any = data.pageId;const _errs141: any = errors;const _errs142: any = errors;if(errors === _errs142){if(typeof data43 === "string"){if(func1(data43) > 256){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data43) < 1){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid32: any = _errs141 === errors;}else {var valid32: any = true;}}}}}else {validate1339.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}var valid31: any = _errs136 === errors;if(props0 !== true){props0 = true;}valid0 = valid31;}else if(tag0 === "saveCanceled"){const _errs145: any = errors;if(errors === _errs145){if(data && typeof data == "object" && !Array.isArray(data)){let missing10: any;if((((data.kind === undefined) && (missing10 = "kind")) || ((data.pageId === undefined) && (missing10 = "pageId"))) || ((data.fileName === undefined) && (missing10 = "fileName"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing10}}];return false;}else {const _errs147: any = errors;for(const key10 in data){if(!(((key10 === "kind") || (key10 === "pageId")) || (key10 === "fileName"))){validate1339.errors = [{instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key10}}];return false;break;}}if(_errs147 === errors){if(data.kind !== undefined){let data44: any = data.kind;const _errs148: any = errors;if(typeof data44 !== "string"){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("saveCanceled" !== data44){validate1339.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/const",keyword:"const",params:{allowedValue: "saveCanceled"}}];return false;}var valid35: any = _errs148 === errors;}else {var valid35: any = true;}if(valid35){if(data.pageId !== undefined){let data45: any = data.pageId;const _errs150: any = errors;const _errs151: any = errors;if(errors === _errs151){if(typeof data45 === "string"){if(func1(data45) > 256){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data45) < 1){validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid35: any = _errs150 === errors;}else {var valid35: any = true;}if(valid35){if(data.fileName !== undefined){let data46: any = data.fileName;const _errs154: any = errors;if(errors === _errs154){if(typeof data46 === "string"){if(func1(data46) > 4096){validate1339.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/6/properties/fileName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data46) < 1){validate1339.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/6/properties/fileName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1339.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/6/properties/fileName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid35: any = _errs154 === errors;}else {var valid35: any = true;}}}}}}else {validate1339.errors = [{instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"}}];return false;}}var valid34: any = _errs145 === errors;if(props0 !== true){props0 = true;}valid0 = valid34;}else {validate1339.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1339.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key11 in data){if(!props0 || !props0[key11]){validate1339.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key11}}];return false;break;}}}}}else {validate1339.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1339.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1339.errors = null as any[] | null;
// prettier-ignore
validate1339.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1341(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1341.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.artifactId === undefined) && (missing0 = "artifactId")){validate1341.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "artifactId") || (key0 === "path"))){validate1341.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.artifactId !== undefined){let data0: any = data.artifactId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1341.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1341.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1341.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}}else {validate1341.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1341.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1341.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1341.errors = null as any[] | null;
// prettier-ignore
validate1341.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1340(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastFileChooseRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1340.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.messageId === undefined) && (missing0 = "messageId"))) || ((data.files === undefined) && (missing0 = "files"))){validate1340.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "messageId")) || (key0 === "files")) || (key0 === "folderName"))){validate1340.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1340.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1340.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1340.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1340.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1340.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageId !== undefined){let data2: any = data.messageId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 256){validate1340.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate1340.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1340.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.files !== undefined){let data3: any = data.files;const _errs14: any = errors;if(errors === _errs14){if(Array.isArray(data3)){var valid4: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs16: any = errors;if(!(validate1341.call(this, data3[i0], {instancePath:instancePath+"/files/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1341.errors : vErrors.concat(validate1341.errors);errors = vErrors.length;}var valid4: any = _errs16 === errors;if(!valid4){break;}}}else {validate1340.errors = [{instancePath:instancePath+"/files",schemaPath:"#/properties/files/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.folderName !== undefined){let data5: any = data.folderName;const _errs17: any = errors;if(errors === _errs17){if(typeof data5 === "string"){if(func1(data5) > 4096){validate1340.errors = [{instancePath:instancePath+"/folderName",schemaPath:"#/properties/folderName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data5) < 1){validate1340.errors = [{instancePath:instancePath+"/folderName",schemaPath:"#/properties/folderName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1340.errors = [{instancePath:instancePath+"/folderName",schemaPath:"#/properties/folderName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1340.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1340.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1340.errors = null as any[] | null;
// prettier-ignore
validate1340.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1343(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastFileChooseResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1343.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.set === undefined) && (missing0 = "set")){validate1343.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "set")){validate1343.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.set !== undefined){let data0: any = data.set;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate1343.errors = [{instancePath:instancePath+"/set",schemaPath:"#/properties/set/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate1343.errors = [{instancePath:instancePath+"/set",schemaPath:"#/properties/set/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate1343.errors = [{instancePath:instancePath+"/set",schemaPath:"#/properties/set/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate1343.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1343.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1343.errors = null as any[] | null;
// prettier-ignore
validate1343.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2523: any = {"description":"What a mouse input does.","type":"string","enum":["press","move","release"]};
// prettier-ignore
const schema2524: any = {"description":"The mouse button an input names.","type":"string","enum":["none","left","middle","right"]};
// prettier-ignore
const schema2525: any = {"description":"What a touch input does.","type":"string","enum":["start","move","end","cancel"]};
// prettier-ignore
const schema2527: any = {"description":"What a key input does.","type":"string","enum":["down","up"]};
// prettier-ignore
function validate1345(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1345.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "mouse"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.type === undefined) && (missing0 = "type"))) || ((data.x === undefined) && (missing0 = "x"))) || ((data.y === undefined) && (missing0 = "y"))) || ((data.button === undefined) && (missing0 = "button"))) || ((data.clickCount === undefined) && (missing0 = "clickCount"))) || ((data.modifiers === undefined) && (missing0 = "modifiers"))){validate1345.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((((key0 === "kind") || (key0 === "type")) || (key0 === "x")) || (key0 === "y")) || (key0 === "button")) || (key0 === "clickCount")) || (key0 === "modifiers"))){validate1345.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validate1345.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("mouse" !== data0){validate1345.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "mouse"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.type !== undefined){let data1: any = data.type;const _errs7: any = errors;if(typeof data1 !== "string"){validate1345.errors = [{instancePath:instancePath+"/type",schemaPath:"#/$defs/PreviewMouseAction/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data1 === "press") || (data1 === "move")) || (data1 === "release"))){validate1345.errors = [{instancePath:instancePath+"/type",schemaPath:"#/$defs/PreviewMouseAction/enum",keyword:"enum",params:{allowedValues: schema2523.enum}}];return false;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.x !== undefined){let data2: any = data.x;const _errs10: any = errors;if(!((typeof data2 == "number") && (isFinite(data2)))){validate1345.errors = [{instancePath:instancePath+"/x",schemaPath:"#/oneOf/0/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.y !== undefined){let data3: any = data.y;const _errs12: any = errors;if(!((typeof data3 == "number") && (isFinite(data3)))){validate1345.errors = [{instancePath:instancePath+"/y",schemaPath:"#/oneOf/0/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.button !== undefined){let data4: any = data.button;const _errs14: any = errors;if(typeof data4 !== "string"){validate1345.errors = [{instancePath:instancePath+"/button",schemaPath:"#/$defs/PreviewMouseButton/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data4 === "none") || (data4 === "left")) || (data4 === "middle")) || (data4 === "right"))){validate1345.errors = [{instancePath:instancePath+"/button",schemaPath:"#/$defs/PreviewMouseButton/enum",keyword:"enum",params:{allowedValues: schema2524.enum}}];return false;}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.clickCount !== undefined){let data5: any = data.clickCount;const _errs17: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate1345.errors = [{instancePath:instancePath+"/clickCount",schemaPath:"#/oneOf/0/properties/clickCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs17){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate1345.errors = [{instancePath:instancePath+"/clickCount",schemaPath:"#/oneOf/0/properties/clickCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validate1345.errors = [{instancePath:instancePath+"/clickCount",schemaPath:"#/oneOf/0/properties/clickCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs17 === errors;}else {var valid2: any = true;}if(valid2){if(data.modifiers !== undefined){let data6: any = data.modifiers;const _errs19: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate1345.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/0/properties/modifiers/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs19){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 15 || isNaN(data6)){validate1345.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/0/properties/modifiers/maximum",keyword:"maximum",params:{comparison: "<=", limit: 15}}];return false;}else {if(data6 < 0 || isNaN(data6)){validate1345.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/0/properties/modifiers/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs19 === errors;}else {var valid2: any = true;}}}}}}}}}}else {validate1345.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "wheel"){const _errs21: any = errors;if(errors === _errs21){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((((data.kind === undefined) && (missing1 = "kind")) || ((data.x === undefined) && (missing1 = "x"))) || ((data.y === undefined) && (missing1 = "y"))) || ((data.deltaX === undefined) && (missing1 = "deltaX"))) || ((data.deltaY === undefined) && (missing1 = "deltaY"))) || ((data.modifiers === undefined) && (missing1 = "modifiers"))){validate1345.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs23: any = errors;for(const key1 in data){if(!((((((key1 === "kind") || (key1 === "x")) || (key1 === "y")) || (key1 === "deltaX")) || (key1 === "deltaY")) || (key1 === "modifiers"))){validate1345.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs23 === errors){if(data.kind !== undefined){let data7: any = data.kind;const _errs24: any = errors;if(typeof data7 !== "string"){validate1345.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("wheel" !== data7){validate1345.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "wheel"}}];return false;}var valid6: any = _errs24 === errors;}else {var valid6: any = true;}if(valid6){if(data.x !== undefined){let data8: any = data.x;const _errs26: any = errors;if(!((typeof data8 == "number") && (isFinite(data8)))){validate1345.errors = [{instancePath:instancePath+"/x",schemaPath:"#/oneOf/1/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid6: any = _errs26 === errors;}else {var valid6: any = true;}if(valid6){if(data.y !== undefined){let data9: any = data.y;const _errs28: any = errors;if(!((typeof data9 == "number") && (isFinite(data9)))){validate1345.errors = [{instancePath:instancePath+"/y",schemaPath:"#/oneOf/1/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid6: any = _errs28 === errors;}else {var valid6: any = true;}if(valid6){if(data.deltaX !== undefined){let data10: any = data.deltaX;const _errs30: any = errors;if(!((typeof data10 == "number") && (isFinite(data10)))){validate1345.errors = [{instancePath:instancePath+"/deltaX",schemaPath:"#/oneOf/1/properties/deltaX/type",keyword:"type",params:{type: "number"}}];return false;}var valid6: any = _errs30 === errors;}else {var valid6: any = true;}if(valid6){if(data.deltaY !== undefined){let data11: any = data.deltaY;const _errs32: any = errors;if(!((typeof data11 == "number") && (isFinite(data11)))){validate1345.errors = [{instancePath:instancePath+"/deltaY",schemaPath:"#/oneOf/1/properties/deltaY/type",keyword:"type",params:{type: "number"}}];return false;}var valid6: any = _errs32 === errors;}else {var valid6: any = true;}if(valid6){if(data.modifiers !== undefined){let data12: any = data.modifiers;const _errs34: any = errors;if(!(((typeof data12 == "number") && (!(data12 % 1) && !isNaN(data12))) && (isFinite(data12)))){validate1345.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/1/properties/modifiers/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs34){if((typeof data12 == "number") && (isFinite(data12))){if(data12 > 15 || isNaN(data12)){validate1345.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/1/properties/modifiers/maximum",keyword:"maximum",params:{comparison: "<=", limit: 15}}];return false;}else {if(data12 < 0 || isNaN(data12)){validate1345.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/1/properties/modifiers/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid6: any = _errs34 === errors;}else {var valid6: any = true;}}}}}}}}}else {validate1345.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs21 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else if(tag0 === "touch"){const _errs36: any = errors;if(errors === _errs36){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.kind === undefined) && (missing2 = "kind")) || ((data.type === undefined) && (missing2 = "type"))) || ((data.points === undefined) && (missing2 = "points"))){validate1345.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs38: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "type")) || (key2 === "points"))){validate1345.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs38 === errors){if(data.kind !== undefined){let data13: any = data.kind;const _errs39: any = errors;if(typeof data13 !== "string"){validate1345.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("touch" !== data13){validate1345.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "touch"}}];return false;}var valid8: any = _errs39 === errors;}else {var valid8: any = true;}if(valid8){if(data.type !== undefined){let data14: any = data.type;const _errs41: any = errors;if(typeof data14 !== "string"){validate1345.errors = [{instancePath:instancePath+"/type",schemaPath:"#/$defs/PreviewTouchAction/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data14 === "start") || (data14 === "move")) || (data14 === "end")) || (data14 === "cancel"))){validate1345.errors = [{instancePath:instancePath+"/type",schemaPath:"#/$defs/PreviewTouchAction/enum",keyword:"enum",params:{allowedValues: schema2525.enum}}];return false;}var valid8: any = _errs41 === errors;}else {var valid8: any = true;}if(valid8){if(data.points !== undefined){let data15: any = data.points;const _errs44: any = errors;if(errors === _errs44){if(Array.isArray(data15)){var valid10: any = true;const len0: any = data15.length;for(let i0=0; i0<len0; i0++){let data16: any = data15[i0];const _errs46: any = errors;const _errs47: any = errors;if(errors === _errs47){if(data16 && typeof data16 == "object" && !Array.isArray(data16)){let missing3: any;if((((data16.x === undefined) && (missing3 = "x")) || ((data16.y === undefined) && (missing3 = "y"))) || ((data16.id === undefined) && (missing3 = "id"))){validate1345.errors = [{instancePath:instancePath+"/points/" + i0,schemaPath:"#/$defs/PreviewTouchPoint/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs49: any = errors;for(const key3 in data16){if(!(((key3 === "x") || (key3 === "y")) || (key3 === "id"))){validate1345.errors = [{instancePath:instancePath+"/points/" + i0,schemaPath:"#/$defs/PreviewTouchPoint/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs49 === errors){if(data16.x !== undefined){let data17: any = data16.x;const _errs50: any = errors;if(!((typeof data17 == "number") && (isFinite(data17)))){validate1345.errors = [{instancePath:instancePath+"/points/" + i0+"/x",schemaPath:"#/$defs/PreviewTouchPoint/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid12: any = _errs50 === errors;}else {var valid12: any = true;}if(valid12){if(data16.y !== undefined){let data18: any = data16.y;const _errs52: any = errors;if(!((typeof data18 == "number") && (isFinite(data18)))){validate1345.errors = [{instancePath:instancePath+"/points/" + i0+"/y",schemaPath:"#/$defs/PreviewTouchPoint/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid12: any = _errs52 === errors;}else {var valid12: any = true;}if(valid12){if(data16.id !== undefined){let data19: any = data16.id;const _errs54: any = errors;if(!(((typeof data19 == "number") && (!(data19 % 1) && !isNaN(data19))) && (isFinite(data19)))){validate1345.errors = [{instancePath:instancePath+"/points/" + i0+"/id",schemaPath:"#/$defs/PreviewTouchPoint/properties/id/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs54){if((typeof data19 == "number") && (isFinite(data19))){if(data19 > 9007199254740991 || isNaN(data19)){validate1345.errors = [{instancePath:instancePath+"/points/" + i0+"/id",schemaPath:"#/$defs/PreviewTouchPoint/properties/id/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data19 < 0 || isNaN(data19)){validate1345.errors = [{instancePath:instancePath+"/points/" + i0+"/id",schemaPath:"#/$defs/PreviewTouchPoint/properties/id/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid12: any = _errs54 === errors;}else {var valid12: any = true;}}}}}}else {validate1345.errors = [{instancePath:instancePath+"/points/" + i0,schemaPath:"#/$defs/PreviewTouchPoint/type",keyword:"type",params:{type: "object"}}];return false;}}var valid10: any = _errs46 === errors;if(!valid10){break;}}}else {validate1345.errors = [{instancePath:instancePath+"/points",schemaPath:"#/oneOf/2/properties/points/type",keyword:"type",params:{type: "array"}}];return false;}}var valid8: any = _errs44 === errors;}else {var valid8: any = true;}}}}}}else {validate1345.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs36 === errors;if(props0 !== true){props0 = true;}valid0 = valid7;}else if(tag0 === "key"){const _errs56: any = errors;if(errors === _errs56){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((((data.kind === undefined) && (missing4 = "kind")) || ((data.type === undefined) && (missing4 = "type"))) || ((data.key === undefined) && (missing4 = "key"))) || ((data.code === undefined) && (missing4 = "code"))) || ((data.modifiers === undefined) && (missing4 = "modifiers"))){validate1345.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs58: any = errors;for(const key4 in data){if(!((((((key4 === "kind") || (key4 === "type")) || (key4 === "key")) || (key4 === "code")) || (key4 === "text")) || (key4 === "modifiers"))){validate1345.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs58 === errors){if(data.kind !== undefined){let data20: any = data.kind;const _errs59: any = errors;if(typeof data20 !== "string"){validate1345.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("key" !== data20){validate1345.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "key"}}];return false;}var valid14: any = _errs59 === errors;}else {var valid14: any = true;}if(valid14){if(data.type !== undefined){let data21: any = data.type;const _errs61: any = errors;if(typeof data21 !== "string"){validate1345.errors = [{instancePath:instancePath+"/type",schemaPath:"#/$defs/PreviewKeyAction/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data21 === "down") || (data21 === "up"))){validate1345.errors = [{instancePath:instancePath+"/type",schemaPath:"#/$defs/PreviewKeyAction/enum",keyword:"enum",params:{allowedValues: schema2527.enum}}];return false;}var valid14: any = _errs61 === errors;}else {var valid14: any = true;}if(valid14){if(data.key !== undefined){let data22: any = data.key;const _errs64: any = errors;if(errors === _errs64){if(typeof data22 === "string"){if(func1(data22) < 1){validate1345.errors = [{instancePath:instancePath+"/key",schemaPath:"#/oneOf/3/properties/key/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1345.errors = [{instancePath:instancePath+"/key",schemaPath:"#/oneOf/3/properties/key/type",keyword:"type",params:{type: "string"}}];return false;}}var valid14: any = _errs64 === errors;}else {var valid14: any = true;}if(valid14){if(data.code !== undefined){const _errs66: any = errors;if(typeof data.code !== "string"){validate1345.errors = [{instancePath:instancePath+"/code",schemaPath:"#/oneOf/3/properties/code/type",keyword:"type",params:{type: "string"}}];return false;}var valid14: any = _errs66 === errors;}else {var valid14: any = true;}if(valid14){if(data.text !== undefined){let data24: any = data.text;const _errs68: any = errors;if(errors === _errs68){if(typeof data24 === "string"){if(func1(data24) < 1){validate1345.errors = [{instancePath:instancePath+"/text",schemaPath:"#/oneOf/3/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1345.errors = [{instancePath:instancePath+"/text",schemaPath:"#/oneOf/3/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}var valid14: any = _errs68 === errors;}else {var valid14: any = true;}if(valid14){if(data.modifiers !== undefined){let data25: any = data.modifiers;const _errs70: any = errors;if(!(((typeof data25 == "number") && (!(data25 % 1) && !isNaN(data25))) && (isFinite(data25)))){validate1345.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/3/properties/modifiers/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs70){if((typeof data25 == "number") && (isFinite(data25))){if(data25 > 15 || isNaN(data25)){validate1345.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/3/properties/modifiers/maximum",keyword:"maximum",params:{comparison: "<=", limit: 15}}];return false;}else {if(data25 < 0 || isNaN(data25)){validate1345.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/3/properties/modifiers/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid14: any = _errs70 === errors;}else {var valid14: any = true;}}}}}}}}}else {validate1345.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid13: any = _errs56 === errors;if(props0 !== true){props0 = true;}valid0 = valid13;}else {validate1345.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1345.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key5 in data){if(!props0 || !props0[key5]){validate1345.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key5}}];return false;break;}}}}}else {validate1345.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1345.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1345.errors = null as any[] | null;
// prettier-ignore
validate1345.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1344(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastInputSendRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1344.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.input === undefined) && (missing0 = "input"))){validate1344.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "input"))){validate1344.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1344.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1344.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1344.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1344.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1344.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.input !== undefined){const _errs10: any = errors;if(!(validate1345.call(this, data.input, {instancePath:instancePath+"/input",parentData:data,parentDataProperty:"input",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1345.errors : vErrors.concat(validate1345.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1344.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1344.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1344.errors = null as any[] | null;
// prettier-ignore
validate1344.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1347(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastInputSendResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1347.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.messageId === undefined) && (missing0 = "messageId")){validate1347.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "messageId")){validate1347.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.messageId !== undefined){let data0: any = data.messageId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1347.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1347.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1347.errors = [{instancePath:instancePath+"/messageId",schemaPath:"#/$defs/PreviewInputMessageId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1347.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1347.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1347.errors = null as any[] | null;
// prettier-ignore
validate1347.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1348(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastSaveAcknowledgeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1348.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.saveId === undefined) && (missing0 = "saveId"))){validate1348.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "saveId"))){validate1348.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1348.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1348.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1348.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1348.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1348.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.saveId !== undefined){let data2: any = data.saveId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 256){validate1348.errors = [{instancePath:instancePath+"/saveId",schemaPath:"#/$defs/PreviewSaveId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate1348.errors = [{instancePath:instancePath+"/saveId",schemaPath:"#/$defs/PreviewSaveId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1348.errors = [{instancePath:instancePath+"/saveId",schemaPath:"#/$defs/PreviewSaveId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1348.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1348.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1348.errors = null as any[] | null;
// prettier-ignore
validate1348.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1349(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1349.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))){validate1349.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "pageId"))){validate1349.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1349.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1349.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){let data1: any = data.pageId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1349.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1349.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1349.errors = [{instancePath:instancePath+"/pageId",schemaPath:"#/$defs/PreviewPageId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1349.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1349.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1349.errors = null as any[] | null;
// prettier-ignore
validate1349.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewAddressRefusedDetails}. */
export const validatePreviewAddressRefusedDetails: SchemaCheck<PreviewAddressRefusedDetails> =
  validate1295;
/** Checks that a value is a {@link PreviewDevServerListFrame}. */
export const validatePreviewDevServerListFrame: SchemaCheck<PreviewDevServerListFrame> =
  validate1299;
/** Checks that a value is a {@link PreviewDevServerSubscribeRequest}. */
export const validatePreviewDevServerSubscribeRequest: SchemaCheck<PreviewDevServerSubscribeRequest> =
  validate1302;
/** Checks that a value is a {@link PreviewInputMessageId}. */
export const validatePreviewInputMessageId: SchemaCheck<PreviewInputMessageId> = validate1303;
/** Checks that a value is a {@link PreviewMarkSendRequest}. */
export const validatePreviewMarkSendRequest: SchemaCheck<PreviewMarkSendRequest> = validate1304;
/** Checks that a value is a {@link PreviewMarkSendResponse}. */
export const validatePreviewMarkSendResponse: SchemaCheck<PreviewMarkSendResponse> = validate1311;
/** Checks that a value is a {@link PreviewMenuEditResponse}. */
export const validatePreviewMenuEditResponse: SchemaCheck<PreviewMenuEditResponse> = validate1315;
/** Checks that a value is a {@link PreviewPage}. */
export const validatePreviewPage: SchemaCheck<PreviewPage> = validate1316;
/** Checks that a value is a {@link PreviewPageActivateResponse}. */
export const validatePreviewPageActivateResponse: SchemaCheck<PreviewPageActivateResponse> =
  validate1319;
/** Checks that a value is a {@link PreviewPageCloseResponse}. */
export const validatePreviewPageCloseResponse: SchemaCheck<PreviewPageCloseResponse> = validate1320;
/** Checks that a value is a {@link PreviewPageId}. */
export const validatePreviewPageId: SchemaCheck<PreviewPageId> = validate1321;
/** Checks that a value is a {@link PreviewPageListFrame}. */
export const validatePreviewPageListFrame: SchemaCheck<PreviewPageListFrame> = validate1322;
/** Checks that a value is a {@link PreviewPageNavigateRequest}. */
export const validatePreviewPageNavigateRequest: SchemaCheck<PreviewPageNavigateRequest> =
  validate1324;
/** Checks that a value is a {@link PreviewPageNavigateResponse}. */
export const validatePreviewPageNavigateResponse: SchemaCheck<PreviewPageNavigateResponse> =
  validate1325;
/** Checks that a value is a {@link PreviewPageOpenRequest}. */
export const validatePreviewPageOpenRequest: SchemaCheck<PreviewPageOpenRequest> = validate1326;
/** Checks that a value is a {@link PreviewPageOpenResponse}. */
export const validatePreviewPageOpenResponse: SchemaCheck<PreviewPageOpenResponse> = validate1329;
/** Checks that a value is a {@link PreviewPageReorderRequest}. */
export const validatePreviewPageReorderRequest: SchemaCheck<PreviewPageReorderRequest> =
  validate1330;
/** Checks that a value is a {@link PreviewPageReorderResponse}. */
export const validatePreviewPageReorderResponse: SchemaCheck<PreviewPageReorderResponse> =
  validate1331;
/** Checks that a value is a {@link PreviewPageRequest}. */
export const validatePreviewPageRequest: SchemaCheck<PreviewPageRequest> = validate1332;
/** Checks that a value is a {@link PreviewPageSubscribeRequest}. */
export const validatePreviewPageSubscribeRequest: SchemaCheck<PreviewPageSubscribeRequest> =
  validate1333;
/** Checks that a value is a {@link PreviewPageZoomUpdateRequest}. */
export const validatePreviewPageZoomUpdateRequest: SchemaCheck<PreviewPageZoomUpdateRequest> =
  validate1334;
/** Checks that a value is a {@link PreviewPageZoomUpdateResponse}. */
export const validatePreviewPageZoomUpdateResponse: SchemaCheck<PreviewPageZoomUpdateResponse> =
  validate1335;
/** Checks that a value is a {@link PreviewSaveId}. */
export const validatePreviewSaveId: SchemaCheck<PreviewSaveId> = validate1336;
/** Checks that a value is a {@link PreviewScreencastAcknowledgeRequest}. */
export const validatePreviewScreencastAcknowledgeRequest: SchemaCheck<PreviewScreencastAcknowledgeRequest> =
  validate1337;
/** Checks that a value is a {@link PreviewScreencastEditRequest}. */
export const validatePreviewScreencastEditRequest: SchemaCheck<PreviewScreencastEditRequest> =
  validate1338;
/** Checks that a value is a {@link PreviewScreencastElement}. */
export const validatePreviewScreencastElement: SchemaCheck<PreviewScreencastElement> = validate1339;
/** Checks that a value is a {@link PreviewScreencastFileChooseRequest}. */
export const validatePreviewScreencastFileChooseRequest: SchemaCheck<PreviewScreencastFileChooseRequest> =
  validate1340;
/** Checks that a value is a {@link PreviewScreencastFileChooseResponse}. */
export const validatePreviewScreencastFileChooseResponse: SchemaCheck<PreviewScreencastFileChooseResponse> =
  validate1343;
/** Checks that a value is a {@link PreviewScreencastInputSendRequest}. */
export const validatePreviewScreencastInputSendRequest: SchemaCheck<PreviewScreencastInputSendRequest> =
  validate1344;
/** Checks that a value is a {@link PreviewScreencastInputSendResponse}. */
export const validatePreviewScreencastInputSendResponse: SchemaCheck<PreviewScreencastInputSendResponse> =
  validate1347;
/** Checks that a value is a {@link PreviewScreencastSaveAcknowledgeRequest}. */
export const validatePreviewScreencastSaveAcknowledgeRequest: SchemaCheck<PreviewScreencastSaveAcknowledgeRequest> =
  validate1348;
/** Checks that a value is a {@link PreviewScreencastSubscribeRequest}. */
export const validatePreviewScreencastSubscribeRequest: SchemaCheck<PreviewScreencastSubscribeRequest> =
  validate1349;

/** The methods of {@link PREVIEW_METHOD_DESCRIPTORS}, each with its checks. */
export interface PreviewMethodDescriptors {
  readonly "preview.page.subscribe": {
    readonly method: "preview.page.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<PreviewPageSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<PreviewPageListFrame>;
  };
  readonly "preview.page.open": {
    readonly method: "preview.page.open";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageOpenRequest>;
    readonly responseCheck: SchemaCheck<PreviewPageOpenResponse>;
  };
  readonly "preview.page.close": {
    readonly method: "preview.page.close";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageRequest>;
    readonly responseCheck: SchemaCheck<PreviewPageCloseResponse>;
  };
  readonly "preview.page.activate": {
    readonly method: "preview.page.activate";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageRequest>;
    readonly responseCheck: SchemaCheck<PreviewPageActivateResponse>;
  };
  readonly "preview.page.reorder": {
    readonly method: "preview.page.reorder";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageReorderRequest>;
    readonly responseCheck: SchemaCheck<PreviewPageReorderResponse>;
  };
  readonly "preview.page.navigate": {
    readonly method: "preview.page.navigate";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageNavigateRequest>;
    readonly responseCheck: SchemaCheck<PreviewPageNavigateResponse>;
  };
  readonly "preview.page.zoom.update": {
    readonly method: "preview.page.zoom.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewPageZoomUpdateRequest>;
    readonly responseCheck: SchemaCheck<PreviewPageZoomUpdateResponse>;
  };
  readonly "preview.devServer.subscribe": {
    readonly method: "preview.devServer.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<PreviewDevServerSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<PreviewDevServerListFrame>;
  };
  readonly "preview.mark.send": {
    readonly method: "preview.mark.send";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewMarkSendRequest>;
    readonly responseCheck: SchemaCheck<PreviewMarkSendResponse>;
  };
  readonly "preview.screencast.subscribe": {
    readonly method: "preview.screencast.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<PreviewScreencastSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<PreviewScreencastElement>;
  };
  readonly "preview.screencast.acknowledge": {
    readonly method: "preview.screencast.acknowledge";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewScreencastAcknowledgeRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "preview.screencast.input.send": {
    readonly method: "preview.screencast.input.send";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewScreencastInputSendRequest>;
    readonly responseCheck: SchemaCheck<PreviewScreencastInputSendResponse>;
  };
  readonly "preview.screencast.edit": {
    readonly method: "preview.screencast.edit";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewScreencastEditRequest>;
    readonly responseCheck: SchemaCheck<PreviewMenuEditResponse>;
  };
  readonly "preview.screencast.file.choose": {
    readonly method: "preview.screencast.file.choose";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewScreencastFileChooseRequest>;
    readonly responseCheck: SchemaCheck<PreviewScreencastFileChooseResponse>;
  };
  readonly "preview.screencast.save.acknowledge": {
    readonly method: "preview.screencast.save.acknowledge";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PreviewScreencastSaveAcknowledgeRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The `preview.*` page, dev-server, marks and live-picture methods the daemon answers. */
export const PREVIEW_METHOD_DESCRIPTORS: PreviewMethodDescriptors = Object.freeze({
  "preview.page.subscribe": Object.freeze({
    method: "preview.page.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validatePreviewPageSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validatePreviewPageListFrame,
  }),
  "preview.page.open": Object.freeze({
    method: "preview.page.open",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewPageOpenRequest,
    responseCheck: validatePreviewPageOpenResponse,
  }),
  "preview.page.close": Object.freeze({
    method: "preview.page.close",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewPageRequest,
    responseCheck: validatePreviewPageCloseResponse,
  }),
  "preview.page.activate": Object.freeze({
    method: "preview.page.activate",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewPageRequest,
    responseCheck: validatePreviewPageActivateResponse,
  }),
  "preview.page.reorder": Object.freeze({
    method: "preview.page.reorder",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewPageReorderRequest,
    responseCheck: validatePreviewPageReorderResponse,
  }),
  "preview.page.navigate": Object.freeze({
    method: "preview.page.navigate",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewPageNavigateRequest,
    responseCheck: validatePreviewPageNavigateResponse,
  }),
  "preview.page.zoom.update": Object.freeze({
    method: "preview.page.zoom.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewPageZoomUpdateRequest,
    responseCheck: validatePreviewPageZoomUpdateResponse,
  }),
  "preview.devServer.subscribe": Object.freeze({
    method: "preview.devServer.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validatePreviewDevServerSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validatePreviewDevServerListFrame,
  }),
  "preview.mark.send": Object.freeze({
    method: "preview.mark.send",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewMarkSendRequest,
    responseCheck: validatePreviewMarkSendResponse,
  }),
  "preview.screencast.subscribe": Object.freeze({
    method: "preview.screencast.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validatePreviewScreencastSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validatePreviewScreencastElement,
  }),
  "preview.screencast.acknowledge": Object.freeze({
    method: "preview.screencast.acknowledge",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewScreencastAcknowledgeRequest,
    responseCheck: validateEmptyPayload,
  }),
  "preview.screencast.input.send": Object.freeze({
    method: "preview.screencast.input.send",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewScreencastInputSendRequest,
    responseCheck: validatePreviewScreencastInputSendResponse,
  }),
  "preview.screencast.edit": Object.freeze({
    method: "preview.screencast.edit",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewScreencastEditRequest,
    responseCheck: validatePreviewMenuEditResponse,
  }),
  "preview.screencast.file.choose": Object.freeze({
    method: "preview.screencast.file.choose",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewScreencastFileChooseRequest,
    responseCheck: validatePreviewScreencastFileChooseResponse,
  }),
  "preview.screencast.save.acknowledge": Object.freeze({
    method: "preview.screencast.save.acknowledge",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePreviewScreencastSaveAcknowledgeRequest,
    responseCheck: validateEmptyPayload,
  }),
});
