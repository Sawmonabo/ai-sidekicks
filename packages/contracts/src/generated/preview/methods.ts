// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The Preview pane's wire: the pages a session owns and the verbs that move them, the dev servers the daemon discovers, the marks sent to the provider, and the live picture for another device with the input, menu acts, chosen files and saves that answer it.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../../schema-check.js";
import { type ArtifactId, validateArtifactId } from "../artifacts/id.js";
import { type HexColor, validateHexColor } from "../color.js";
import { type Port, validateBytes, validatePort } from "../internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import {
  type SessionAttachmentSummary,
  validateSessionAttachmentSummary,
} from "../session/draft.js";
import { type SessionId, validateSessionId } from "../session/id.js";
import { type WebAddressFault, validateWebAddressFault } from "../web-address.js";

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
const func1 = ucs2length;
/** Checks that a value is a {@link PreviewPageId}. */
// prettier-ignore
export const validatePreviewPageId: CompiledSchemaCheck<PreviewPageId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validatePreviewPageId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validatePreviewPageId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewPageId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validatePreviewPageId.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema814: any = {"description":"A refused address's text that is not an address at all.","type":"string","enum":["notAnAddress"]};
/** Checks that a value is a {@link PreviewUnparsedAddress}. */
// prettier-ignore
export const validatePreviewUnparsedAddress: CompiledSchemaCheck<PreviewUnparsedAddress> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewUnparsedAddress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewUnparsedAddress.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePreviewUnparsedAddress.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "notAnAddress")){validatePreviewUnparsedAddress.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema814.enum}}];return false;}validatePreviewUnparsedAddress.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewUnparsedAddress.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewAddressRefusedReason}. */
// prettier-ignore
export const validatePreviewAddressRefusedReason: CompiledSchemaCheck<PreviewAddressRefusedReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewAddressRefusedReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewAddressRefusedReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validateWebAddressFault.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWebAddressFault.errors : vErrors.concat(validateWebAddressFault.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;const _errs2: any = errors;if(!(validatePreviewUnparsedAddress.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewUnparsedAddress.errors : vErrors.concat(validatePreviewUnparsedAddress.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validatePreviewAddressRefusedReason.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validatePreviewAddressRefusedReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewAddressRefusedReason.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewAddressRefusedDetails}. */
// prettier-ignore
export const validatePreviewAddressRefusedDetails: CompiledSchemaCheck<PreviewAddressRefusedDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewAddressRefusedDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewAddressRefusedDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.reason === undefined) && (missing0 = "reason")){validatePreviewAddressRefusedDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "reason")){validatePreviewAddressRefusedDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reason !== undefined){if(!(validatePreviewAddressRefusedReason.call(this, data.reason, {instancePath:instancePath+"/reason",parentData:data,parentDataProperty:"reason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewAddressRefusedReason.errors : vErrors.concat(validatePreviewAddressRefusedReason.errors);errors = vErrors.length;}}}}}else {validatePreviewAddressRefusedDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewAddressRefusedDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewAddressRefusedDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern593 = new RegExp("^image/[a-z0-9.+-]+$", "u");
/** Checks that a value is a {@link PreviewFavicon}. */
// prettier-ignore
export const validatePreviewFavicon: CompiledSchemaCheck<PreviewFavicon> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewFavicon {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewFavicon.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.mediaType === undefined) && (missing0 = "mediaType")) || ((data.data === undefined) && (missing0 = "data"))){validatePreviewFavicon.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "mediaType") || (key0 === "data"))){validatePreviewFavicon.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.mediaType !== undefined){let data0: any = data.mediaType;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(!pattern593.test(data0)){validatePreviewFavicon.errors = [{instancePath:instancePath+"/mediaType",schemaPath:"#/properties/mediaType/pattern",keyword:"pattern",params:{pattern: "^image/[a-z0-9.+-]+$"}}];return false;}}else {validatePreviewFavicon.errors = [{instancePath:instancePath+"/mediaType",schemaPath:"#/properties/mediaType/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.data !== undefined){let data1: any = data.data;const _errs4: any = errors;if(!(validateBytes.call(this, data1, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data1 && typeof data1 == "object" && Number.isInteger(data1.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data1.$bytes] instanceof Uint8Array && this.attachments[data1.$bytes].byteLength >= 1)){validatePreviewFavicon.errors = [{instancePath:instancePath+"/data",schemaPath:"#/properties/data/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data1 && typeof data1 == "object" && Number.isInteger(data1.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data1.$bytes] instanceof Uint8Array && this.attachments[data1.$bytes].byteLength <= 4194300)){validatePreviewFavicon.errors = [{instancePath:instancePath+"/data",schemaPath:"#/properties/data/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewFavicon.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewFavicon.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewFavicon.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema831: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"loading"},"progress":{"type":["number","null"],"minimum":0,"maximum":1,"description":"The share loaded; `null` draws an indeterminate mark."}},"required":["kind","progress"],"description":"Loading."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"loaded"}},"required":["kind"],"description":"Loaded."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"failed"}},"required":["kind"],"description":"Failed."}],"description":"Where a page's load stands, tagged on `kind`: loading, with the fraction the engine reports or\n`null` when it reports none; loaded; or failed, which the pane reads as `<host> did not answer.`\nwith a try-again.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
/** Checks that a value is a {@link PreviewPageLoadState}. */
// prettier-ignore
export const validatePreviewPageLoadState: CompiledSchemaCheck<PreviewPageLoadState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageLoadState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageLoadState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "loading"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.progress === undefined) && (missing0 = "progress"))){validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "kind") || (key0 === "progress"))){validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validatePreviewPageLoadState.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("loading" !== data0){validatePreviewPageLoadState.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "loading"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.progress !== undefined){let data1: any = data.progress;const _errs7: any = errors;if((!((typeof data1 == "number") && (isFinite(data1)))) && (data1 !== null)){validatePreviewPageLoadState.errors = [{instancePath:instancePath+"/progress",schemaPath:"#/oneOf/0/properties/progress/type",keyword:"type",params:{type: schema831.oneOf[0].properties.progress.type}}];return false;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 1 || isNaN(data1)){validatePreviewPageLoadState.errors = [{instancePath:instancePath+"/progress",schemaPath:"#/oneOf/0/properties/progress/maximum",keyword:"maximum",params:{comparison: "<=", limit: 1}}];return false;}else {if(data1 < 0 || isNaN(data1)){validatePreviewPageLoadState.errors = [{instancePath:instancePath+"/progress",schemaPath:"#/oneOf/0/properties/progress/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "loaded"){const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.kind === undefined) && (missing1 = "kind")){validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key1 in data){if(!(key1 === "kind")){validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs11 === errors){if(data.kind !== undefined){let data2: any = data.kind;if(typeof data2 !== "string"){validatePreviewPageLoadState.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("loaded" !== data2){validatePreviewPageLoadState.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "loaded"}}];return false;}}}}}else {validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs9 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "failed"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.kind === undefined) && (missing2 = "kind")){validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs16: any = errors;for(const key2 in data){if(!(key2 === "kind")){validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs16 === errors){if(data.kind !== undefined){let data3: any = data.kind;if(typeof data3 !== "string"){validatePreviewPageLoadState.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data3){validatePreviewPageLoadState.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}}}}}else {validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs14 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validatePreviewPageLoadState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageLoadState.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageLoadState.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema829: any = {"type":"object","additionalProperties":false,"properties":{"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"address":{"type":"string","minLength":1,"maxLength":2097152,"description":"Its address."},"host":{"type":"string","description":"Its host, shown in place of an empty `title`, so it is carried rather than re-parsed."},"title":{"type":"string","description":"The page's own title; may be empty."},"favicon":{"anyOf":[{"$ref":"#/$defs/PreviewFavicon"},{"type":"null"}],"description":"Its icon; `null` where it has none."},"loadState":{"$ref":"#/$defs/PreviewPageLoadState","description":"Where its load stands."},"backDepth":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How far its history reaches back; going back is possible above zero."},"forwardDepth":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How far its history reaches forward; going forward is possible above zero."},"zoomFactor":{"description":"Its own zoom, applied on the machine that runs it.","type":"number","enum":[0.5,0.6666666666666666,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2]},"released":{"type":"boolean","description":"The page's view was destroyed to free memory or by a restart; its address, order and zoom\nare kept, and it reloads when shown."}},"required":["pageId","address","host","title","favicon","loadState","backDepth","forwardDepth","zoomFactor","released"],"description":"One open page in a session's Preview pane."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link PreviewPage}. */
// prettier-ignore
export const validatePreviewPage: CompiledSchemaCheck<PreviewPage> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPage {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPage.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.address === undefined) && (missing0 = "address"))) || ((data.host === undefined) && (missing0 = "host"))) || ((data.title === undefined) && (missing0 = "title"))) || ((data.favicon === undefined) && (missing0 = "favicon"))) || ((data.loadState === undefined) && (missing0 = "loadState"))) || ((data.backDepth === undefined) && (missing0 = "backDepth"))) || ((data.forwardDepth === undefined) && (missing0 = "forwardDepth"))) || ((data.zoomFactor === undefined) && (missing0 = "zoomFactor"))) || ((data.released === undefined) && (missing0 = "released"))){validatePreviewPage.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema829.properties, key0))){validatePreviewPage.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){const _errs2: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.address !== undefined){let data1: any = data.address;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 2097152){validatePreviewPage.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validatePreviewPage.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewPage.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.host !== undefined){const _errs5: any = errors;if(typeof data.host !== "string"){validatePreviewPage.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.title !== undefined){const _errs7: any = errors;if(typeof data.title !== "string"){validatePreviewPage.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.favicon !== undefined){let data4: any = data.favicon;const _errs9: any = errors;const _errs10: any = errors;let valid1: any = false;const _errs11: any = errors;if(!(validatePreviewFavicon.call(this, data4, {instancePath:instancePath+"/favicon",parentData:data,parentDataProperty:"favicon",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewFavicon.errors : vErrors.concat(validatePreviewFavicon.errors);errors = vErrors.length;}var _valid0: any = _errs11 === errors;valid1 = valid1 || _valid0;const _errs12: any = errors;if(data4 !== null){const err0: any = {instancePath:instancePath+"/favicon",schemaPath:"#/properties/favicon/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs12 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/favicon",schemaPath:"#/properties/favicon/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validatePreviewPage.errors = vErrors;return false;}else {errors = _errs10;if(vErrors !== null){if(_errs10){vErrors.length = _errs10;}else {vErrors = null;}}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.loadState !== undefined){const _errs14: any = errors;if(!(validatePreviewPageLoadState.call(this, data.loadState, {instancePath:instancePath+"/loadState",parentData:data,parentDataProperty:"loadState",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageLoadState.errors : vErrors.concat(validatePreviewPageLoadState.errors);errors = vErrors.length;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.backDepth !== undefined){let data6: any = data.backDepth;const _errs15: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validatePreviewPage.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validatePreviewPage.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validatePreviewPage.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.forwardDepth !== undefined){let data7: any = data.forwardDepth;const _errs17: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validatePreviewPage.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs17){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validatePreviewPage.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 0 || isNaN(data7)){validatePreviewPage.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}if(valid0){if(data.zoomFactor !== undefined){let data8: any = data.zoomFactor;const _errs19: any = errors;if(!((typeof data8 == "number") && (isFinite(data8)))){validatePreviewPage.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/type",keyword:"type",params:{type: "number"}}];return false;}if(!(((((((((((data8 === 0.5) || (data8 === 0.6666666666666666)) || (data8 === 0.75)) || (data8 === 0.8)) || (data8 === 0.9)) || (data8 === 1)) || (data8 === 1.1)) || (data8 === 1.25)) || (data8 === 1.5)) || (data8 === 1.75)) || (data8 === 2))){validatePreviewPage.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/enum",keyword:"enum",params:{allowedValues: schema829.properties.zoomFactor.enum}}];return false;}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}if(valid0){if(data.released !== undefined){const _errs21: any = errors;if(typeof data.released !== "boolean"){validatePreviewPage.errors = [{instancePath:instancePath+"/released",schemaPath:"#/properties/released/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs21 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}else {validatePreviewPage.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPage.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPage.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageSubscribeRequest}. */
// prettier-ignore
export const validatePreviewPageSubscribeRequest: CompiledSchemaCheck<PreviewPageSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validatePreviewPageSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validatePreviewPageSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validatePreviewPageSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageListFrame}. */
// prettier-ignore
export const validatePreviewPageListFrame: CompiledSchemaCheck<PreviewPageListFrame> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageListFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageListFrame.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.pages === undefined) && (missing0 = "pages")) || ((data.activeIndex === undefined) && (missing0 = "activeIndex"))){validatePreviewPageListFrame.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "pages") || (key0 === "activeIndex"))){validatePreviewPageListFrame.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pages !== undefined){let data0: any = data.pages;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validatePreviewPage.call(this, data0[i0], {instancePath:instancePath+"/pages/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPage.errors : vErrors.concat(validatePreviewPage.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validatePreviewPageListFrame.errors = [{instancePath:instancePath+"/pages",schemaPath:"#/properties/pages/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.activeIndex !== undefined){let data2: any = data.activeIndex;const _errs5: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validatePreviewPageListFrame.errors = [{instancePath:instancePath+"/activeIndex",schemaPath:"#/properties/activeIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validatePreviewPageListFrame.errors = [{instancePath:instancePath+"/activeIndex",schemaPath:"#/properties/activeIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < -1 || isNaN(data2)){validatePreviewPageListFrame.errors = [{instancePath:instancePath+"/activeIndex",schemaPath:"#/properties/activeIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: -1}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewPageListFrame.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageListFrame.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageListFrame.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageTarget}. */
// prettier-ignore
export const validatePreviewPageTarget: CompiledSchemaCheck<PreviewPageTarget> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageTarget {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageTarget.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "address"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.address === undefined) && (missing0 = "address"))){validatePreviewPageTarget.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "kind") || (key0 === "address"))){validatePreviewPageTarget.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validatePreviewPageTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("address" !== data0){validatePreviewPageTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "address"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.address !== undefined){let data1: any = data.address;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 2097152){validatePreviewPageTarget.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validatePreviewPageTarget.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewPageTarget.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validatePreviewPageTarget.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "devServer"){const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.kind === undefined) && (missing1 = "kind")) || ((data.port === undefined) && (missing1 = "port"))){validatePreviewPageTarget.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key1 in data){if(!((key1 === "kind") || (key1 === "port"))){validatePreviewPageTarget.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs11 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs12: any = errors;if(typeof data2 !== "string"){validatePreviewPageTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("devServer" !== data2){validatePreviewPageTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "devServer"}}];return false;}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}if(valid4){if(data.port !== undefined){const _errs14: any = errors;if(!(validatePort.call(this, data.port, {instancePath:instancePath+"/port",parentData:data,parentDataProperty:"port",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePort.errors : vErrors.concat(validatePort.errors);errors = vErrors.length;}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}}}}}else {validatePreviewPageTarget.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs9 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validatePreviewPageTarget.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validatePreviewPageTarget.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validatePreviewPageTarget.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validatePreviewPageTarget.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageTarget.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageTarget.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageOpenRequest}. */
// prettier-ignore
export const validatePreviewPageOpenRequest: CompiledSchemaCheck<PreviewPageOpenRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageOpenRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageOpenRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.target === undefined) && (missing0 = "target"))){validatePreviewPageOpenRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "target"))){validatePreviewPageOpenRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.target !== undefined){const _errs3: any = errors;if(!(validatePreviewPageTarget.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageTarget.errors : vErrors.concat(validatePreviewPageTarget.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewPageOpenRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageOpenRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageOpenRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageOpenResponse}. */
// prettier-ignore
export const validatePreviewPageOpenResponse: CompiledSchemaCheck<PreviewPageOpenResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageOpenResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageOpenResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.address === undefined) && (missing0 = "address"))) || ((data.movedFrom === undefined) && (missing0 = "movedFrom"))){validatePreviewPageOpenResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "pageId") || (key0 === "address")) || (key0 === "movedFrom")) || (key0 === "releasedPageId"))){validatePreviewPageOpenResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){const _errs2: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.address !== undefined){let data1: any = data.address;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 2097152){validatePreviewPageOpenResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validatePreviewPageOpenResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewPageOpenResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.movedFrom !== undefined){let data2: any = data.movedFrom;const _errs5: any = errors;const _errs6: any = errors;let valid1: any = false;const _errs7: any = errors;if(!(validatePort.call(this, data2, {instancePath:instancePath+"/movedFrom",parentData:data,parentDataProperty:"movedFrom",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePort.errors : vErrors.concat(validatePort.errors);errors = vErrors.length;}var _valid0: any = _errs7 === errors;valid1 = valid1 || _valid0;const _errs8: any = errors;if(data2 !== null){const err0: any = {instancePath:instancePath+"/movedFrom",schemaPath:"#/properties/movedFrom/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs8 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/movedFrom",schemaPath:"#/properties/movedFrom/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validatePreviewPageOpenResponse.errors = vErrors;return false;}else {errors = _errs6;if(vErrors !== null){if(_errs6){vErrors.length = _errs6;}else {vErrors = null;}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.releasedPageId !== undefined){const _errs10: any = errors;if(!(validatePreviewPageId.call(this, data.releasedPageId, {instancePath:instancePath+"/releasedPageId",parentData:data,parentDataProperty:"releasedPageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}else {validatePreviewPageOpenResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageOpenResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageOpenResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageRequest}. */
// prettier-ignore
export const validatePreviewPageRequest: CompiledSchemaCheck<PreviewPageRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))){validatePreviewPageRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "pageId"))){validatePreviewPageRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){const _errs3: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewPageRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageCloseResponse}. */
// prettier-ignore
export const validatePreviewPageCloseResponse: CompiledSchemaCheck<PreviewPageCloseResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageCloseResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageCloseResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.closed === undefined) && (missing0 = "closed")){validatePreviewPageCloseResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "closed")){validatePreviewPageCloseResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.closed !== undefined){let data0: any = data.closed;if(typeof data0 !== "boolean"){validatePreviewPageCloseResponse.errors = [{instancePath:instancePath+"/closed",schemaPath:"#/properties/closed/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validatePreviewPageCloseResponse.errors = [{instancePath:instancePath+"/closed",schemaPath:"#/properties/closed/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validatePreviewPageCloseResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageCloseResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageCloseResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageActivateResponse}. */
// prettier-ignore
export const validatePreviewPageActivateResponse: CompiledSchemaCheck<PreviewPageActivateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageActivateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageActivateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.activePageId === undefined) && (missing0 = "activePageId")){validatePreviewPageActivateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "activePageId")){validatePreviewPageActivateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.activePageId !== undefined){if(!(validatePreviewPageId.call(this, data.activePageId, {instancePath:instancePath+"/activePageId",parentData:data,parentDataProperty:"activePageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}}}}}else {validatePreviewPageActivateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageActivateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageActivateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageReorderRequest}. */
// prettier-ignore
export const validatePreviewPageReorderRequest: CompiledSchemaCheck<PreviewPageReorderRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageReorderRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageReorderRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.toIndex === undefined) && (missing0 = "toIndex"))){validatePreviewPageReorderRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "toIndex"))){validatePreviewPageReorderRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){const _errs3: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.toIndex !== undefined){let data2: any = data.toIndex;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validatePreviewPageReorderRequest.errors = [{instancePath:instancePath+"/toIndex",schemaPath:"#/properties/toIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validatePreviewPageReorderRequest.errors = [{instancePath:instancePath+"/toIndex",schemaPath:"#/properties/toIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validatePreviewPageReorderRequest.errors = [{instancePath:instancePath+"/toIndex",schemaPath:"#/properties/toIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePreviewPageReorderRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageReorderRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageReorderRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageReorderResponse}. */
// prettier-ignore
export const validatePreviewPageReorderResponse: CompiledSchemaCheck<PreviewPageReorderResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageReorderResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageReorderResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.pageIds === undefined) && (missing0 = "pageIds")){validatePreviewPageReorderResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "pageIds")){validatePreviewPageReorderResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageIds !== undefined){let data0: any = data.pageIds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validatePreviewPageId.call(this, data0[i0], {instancePath:instancePath+"/pageIds/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validatePreviewPageReorderResponse.errors = [{instancePath:instancePath+"/pageIds",schemaPath:"#/properties/pageIds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validatePreviewPageReorderResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageReorderResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageReorderResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewNavigationTarget}. */
// prettier-ignore
export const validatePreviewNavigationTarget: CompiledSchemaCheck<PreviewNavigationTarget> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewNavigationTarget {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewNavigationTarget.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "address"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.address === undefined) && (missing0 = "address"))){validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "kind") || (key0 === "address"))){validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validatePreviewNavigationTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("address" !== data0){validatePreviewNavigationTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "address"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.address !== undefined){let data1: any = data.address;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 2097152){validatePreviewNavigationTarget.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validatePreviewNavigationTarget.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewNavigationTarget.errors = [{instancePath:instancePath+"/address",schemaPath:"#/oneOf/0/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "back"){const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.kind === undefined) && (missing1 = "kind")){validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key1 in data){if(!(key1 === "kind")){validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs11 === errors){if(data.kind !== undefined){let data2: any = data.kind;if(typeof data2 !== "string"){validatePreviewNavigationTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("back" !== data2){validatePreviewNavigationTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "back"}}];return false;}}}}}else {validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs9 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "forward"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.kind === undefined) && (missing2 = "kind")){validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs16: any = errors;for(const key2 in data){if(!(key2 === "kind")){validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs16 === errors){if(data.kind !== undefined){let data3: any = data.kind;if(typeof data3 !== "string"){validatePreviewNavigationTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("forward" !== data3){validatePreviewNavigationTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "forward"}}];return false;}}}}}else {validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs14 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else if(tag0 === "reload"){const _errs19: any = errors;if(errors === _errs19){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((data.kind === undefined) && (missing3 = "kind")){validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs21: any = errors;for(const key3 in data){if(!(key3 === "kind")){validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs21 === errors){if(data.kind !== undefined){let data4: any = data.kind;if(typeof data4 !== "string"){validatePreviewNavigationTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("reload" !== data4){validatePreviewNavigationTarget.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "reload"}}];return false;}}}}}else {validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs19 === errors;if(props0 !== true){props0 = true;}valid0 = valid7;}else {validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key4 in data){if(!props0 || !props0[key4]){validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key4}}];return false;break;}}}}}else {validatePreviewNavigationTarget.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewNavigationTarget.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewNavigationTarget.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageNavigateRequest}. */
// prettier-ignore
export const validatePreviewPageNavigateRequest: CompiledSchemaCheck<PreviewPageNavigateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageNavigateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageNavigateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.to === undefined) && (missing0 = "to"))){validatePreviewPageNavigateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "to"))){validatePreviewPageNavigateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){const _errs3: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.to !== undefined){const _errs4: any = errors;if(!(validatePreviewNavigationTarget.call(this, data.to, {instancePath:instancePath+"/to",parentData:data,parentDataProperty:"to",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewNavigationTarget.errors : vErrors.concat(validatePreviewNavigationTarget.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePreviewPageNavigateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageNavigateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageNavigateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPageNavigateResponse}. */
// prettier-ignore
export const validatePreviewPageNavigateResponse: CompiledSchemaCheck<PreviewPageNavigateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageNavigateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageNavigateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.pageId === undefined) && (missing0 = "pageId")) || ((data.address === undefined) && (missing0 = "address"))) || ((data.movedFrom === undefined) && (missing0 = "movedFrom"))) || ((data.backDepth === undefined) && (missing0 = "backDepth"))) || ((data.forwardDepth === undefined) && (missing0 = "forwardDepth"))){validatePreviewPageNavigateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "pageId") || (key0 === "address")) || (key0 === "movedFrom")) || (key0 === "backDepth")) || (key0 === "forwardDepth"))){validatePreviewPageNavigateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){const _errs2: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.address !== undefined){let data1: any = data.address;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 2097152){validatePreviewPageNavigateResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data1) < 1){validatePreviewPageNavigateResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewPageNavigateResponse.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.movedFrom !== undefined){let data2: any = data.movedFrom;const _errs5: any = errors;const _errs6: any = errors;let valid1: any = false;const _errs7: any = errors;if(!(validatePort.call(this, data2, {instancePath:instancePath+"/movedFrom",parentData:data,parentDataProperty:"movedFrom",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePort.errors : vErrors.concat(validatePort.errors);errors = vErrors.length;}var _valid0: any = _errs7 === errors;valid1 = valid1 || _valid0;const _errs8: any = errors;if(data2 !== null){const err0: any = {instancePath:instancePath+"/movedFrom",schemaPath:"#/properties/movedFrom/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs8 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/movedFrom",schemaPath:"#/properties/movedFrom/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validatePreviewPageNavigateResponse.errors = vErrors;return false;}else {errors = _errs6;if(vErrors !== null){if(_errs6){vErrors.length = _errs6;}else {vErrors = null;}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.backDepth !== undefined){let data3: any = data.backDepth;const _errs10: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validatePreviewPageNavigateResponse.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validatePreviewPageNavigateResponse.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validatePreviewPageNavigateResponse.errors = [{instancePath:instancePath+"/backDepth",schemaPath:"#/properties/backDepth/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.forwardDepth !== undefined){let data4: any = data.forwardDepth;const _errs12: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validatePreviewPageNavigateResponse.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validatePreviewPageNavigateResponse.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validatePreviewPageNavigateResponse.errors = [{instancePath:instancePath+"/forwardDepth",schemaPath:"#/properties/forwardDepth/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}}else {validatePreviewPageNavigateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageNavigateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageNavigateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema845: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"zoomFactor":{"description":"The factor.","type":"number","enum":[0.5,0.6666666666666666,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2]}},"required":["sessionId","pageId","zoomFactor"],"description":"Sets one page's zoom on the machine that runs it, so the live picture carries the result. A new\npage starts at 1; each open page keeps its own factor."};
/** Checks that a value is a {@link PreviewPageZoomUpdateRequest}. */
// prettier-ignore
export const validatePreviewPageZoomUpdateRequest: CompiledSchemaCheck<PreviewPageZoomUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageZoomUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageZoomUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.zoomFactor === undefined) && (missing0 = "zoomFactor"))){validatePreviewPageZoomUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "zoomFactor"))){validatePreviewPageZoomUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){const _errs3: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.zoomFactor !== undefined){let data2: any = data.zoomFactor;const _errs4: any = errors;if(!((typeof data2 == "number") && (isFinite(data2)))){validatePreviewPageZoomUpdateRequest.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/type",keyword:"type",params:{type: "number"}}];return false;}if(!(((((((((((data2 === 0.5) || (data2 === 0.6666666666666666)) || (data2 === 0.75)) || (data2 === 0.8)) || (data2 === 0.9)) || (data2 === 1)) || (data2 === 1.1)) || (data2 === 1.25)) || (data2 === 1.5)) || (data2 === 1.75)) || (data2 === 2))){validatePreviewPageZoomUpdateRequest.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/enum",keyword:"enum",params:{allowedValues: schema845.properties.zoomFactor.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePreviewPageZoomUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageZoomUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageZoomUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema846: any = {"type":"object","additionalProperties":false,"properties":{"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"zoomFactor":{"description":"The factor.","type":"number","enum":[0.5,0.6666666666666666,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2]}},"required":["pageId","zoomFactor"],"description":"The factor the page now has."};
/** Checks that a value is a {@link PreviewPageZoomUpdateResponse}. */
// prettier-ignore
export const validatePreviewPageZoomUpdateResponse: CompiledSchemaCheck<PreviewPageZoomUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPageZoomUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPageZoomUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.pageId === undefined) && (missing0 = "pageId")) || ((data.zoomFactor === undefined) && (missing0 = "zoomFactor"))){validatePreviewPageZoomUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "pageId") || (key0 === "zoomFactor"))){validatePreviewPageZoomUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.pageId !== undefined){const _errs2: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.zoomFactor !== undefined){let data1: any = data.zoomFactor;const _errs3: any = errors;if(!((typeof data1 == "number") && (isFinite(data1)))){validatePreviewPageZoomUpdateResponse.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/type",keyword:"type",params:{type: "number"}}];return false;}if(!(((((((((((data1 === 0.5) || (data1 === 0.6666666666666666)) || (data1 === 0.75)) || (data1 === 0.8)) || (data1 === 0.9)) || (data1 === 1)) || (data1 === 1.1)) || (data1 === 1.25)) || (data1 === 1.5)) || (data1 === 1.75)) || (data1 === 2))){validatePreviewPageZoomUpdateResponse.errors = [{instancePath:instancePath+"/zoomFactor",schemaPath:"#/properties/zoomFactor/enum",keyword:"enum",params:{allowedValues: schema846.properties.zoomFactor.enum}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewPageZoomUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPageZoomUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPageZoomUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewDevServerSubscribeRequest}. */
// prettier-ignore
export const validatePreviewDevServerSubscribeRequest: CompiledSchemaCheck<PreviewDevServerSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDevServerSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewDevServerSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validatePreviewDevServerSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validatePreviewDevServerSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validatePreviewDevServerSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewDevServerSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewDevServerSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema816: any = {"type":"object","additionalProperties":false,"properties":{"port":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Port","description":"Its port."},"name":{"type":["string","null"],"minLength":1,"description":"The name it gave."},"framework":{"type":["string","null"],"minLength":1,"description":"Its framework."},"startedHere":{"type":"boolean","description":"Whether this session started it, by its agent or in its own shell."}},"required":["port","name","framework","startedHere"],"description":"One dev server the daemon found listening in the session's project. `name` and `framework` are\n`null` where the daemon could not tell; `startedHere` means this session started it."};
/** Checks that a value is a {@link PreviewDevServer}. */
// prettier-ignore
export const validatePreviewDevServer: CompiledSchemaCheck<PreviewDevServer> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDevServer {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewDevServer.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.port === undefined) && (missing0 = "port")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.framework === undefined) && (missing0 = "framework"))) || ((data.startedHere === undefined) && (missing0 = "startedHere"))){validatePreviewDevServer.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "port") || (key0 === "name")) || (key0 === "framework")) || (key0 === "startedHere"))){validatePreviewDevServer.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.port !== undefined){const _errs2: any = errors;if(!(validatePort.call(this, data.port, {instancePath:instancePath+"/port",parentData:data,parentDataProperty:"port",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePort.errors : vErrors.concat(validatePort.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if((typeof data1 !== "string") && (data1 !== null)){validatePreviewDevServer.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: schema816.properties.name.type}}];return false;}if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validatePreviewDevServer.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.framework !== undefined){let data2: any = data.framework;const _errs5: any = errors;if((typeof data2 !== "string") && (data2 !== null)){validatePreviewDevServer.errors = [{instancePath:instancePath+"/framework",schemaPath:"#/properties/framework/type",keyword:"type",params:{type: schema816.properties.framework.type}}];return false;}if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) < 1){validatePreviewDevServer.errors = [{instancePath:instancePath+"/framework",schemaPath:"#/properties/framework/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.startedHere !== undefined){const _errs7: any = errors;if(typeof data.startedHere !== "boolean"){validatePreviewDevServer.errors = [{instancePath:instancePath+"/startedHere",schemaPath:"#/properties/startedHere/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validatePreviewDevServer.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewDevServer.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewDevServer.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewDevServerListFrame}. */
// prettier-ignore
export const validatePreviewDevServerListFrame: CompiledSchemaCheck<PreviewDevServerListFrame> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDevServerListFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewDevServerListFrame.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(Array.isArray(data)){var valid0: any = true;const len0: any = data.length;for(let i0=0; i0<len0; i0++){const _errs1: any = errors;if(!(validatePreviewDevServer.call(this, data[i0], {instancePath:instancePath+"/" + i0,parentData:data,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewDevServer.errors : vErrors.concat(validatePreviewDevServer.errors);errors = vErrors.length;}var valid0: any = _errs1 === errors;if(!valid0){break;}}}else {validatePreviewDevServerListFrame.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "array"}}];return false;}}validatePreviewDevServerListFrame.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewDevServerListFrame.evaluated = {"items":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewPoint}. */
// prettier-ignore
export const validatePreviewPoint: CompiledSchemaCheck<PreviewPoint> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewPoint {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewPoint.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.x === undefined) && (missing0 = "x")) || ((data.y === undefined) && (missing0 = "y"))){validatePreviewPoint.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "x") || (key0 === "y"))){validatePreviewPoint.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.x !== undefined){let data0: any = data.x;const _errs2: any = errors;if(!((typeof data0 == "number") && (isFinite(data0)))){validatePreviewPoint.errors = [{instancePath:instancePath+"/x",schemaPath:"#/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.y !== undefined){let data1: any = data.y;const _errs4: any = errors;if(!((typeof data1 == "number") && (isFinite(data1)))){validatePreviewPoint.errors = [{instancePath:instancePath+"/y",schemaPath:"#/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewPoint.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewPoint.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewPoint.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewRect}. */
// prettier-ignore
export const validatePreviewRect: CompiledSchemaCheck<PreviewRect> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewRect {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewRect.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.x === undefined) && (missing0 = "x")) || ((data.y === undefined) && (missing0 = "y"))) || ((data.width === undefined) && (missing0 = "width"))) || ((data.height === undefined) && (missing0 = "height"))){validatePreviewRect.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "x") || (key0 === "y")) || (key0 === "width")) || (key0 === "height"))){validatePreviewRect.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.x !== undefined){let data0: any = data.x;const _errs2: any = errors;if(!((typeof data0 == "number") && (isFinite(data0)))){validatePreviewRect.errors = [{instancePath:instancePath+"/x",schemaPath:"#/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.y !== undefined){let data1: any = data.y;const _errs4: any = errors;if(!((typeof data1 == "number") && (isFinite(data1)))){validatePreviewRect.errors = [{instancePath:instancePath+"/y",schemaPath:"#/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.width !== undefined){let data2: any = data.width;const _errs6: any = errors;if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 < 0 || isNaN(data2)){validatePreviewRect.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}else {validatePreviewRect.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/type",keyword:"type",params:{type: "number"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.height !== undefined){let data3: any = data.height;const _errs8: any = errors;if(errors === _errs8){if((typeof data3 == "number") && (isFinite(data3))){if(data3 < 0 || isNaN(data3)){validatePreviewRect.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}else {validatePreviewRect.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/type",keyword:"type",params:{type: "number"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}else {validatePreviewRect.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewRect.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewRect.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewElementRef}. */
// prettier-ignore
export const validatePreviewElementRef: CompiledSchemaCheck<PreviewElementRef> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewElementRef {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewElementRef.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validatePreviewElementRef.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePreviewElementRef.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validatePreviewElementRef.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewElementRef.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewMarkElement}. */
// prettier-ignore
export const validatePreviewMarkElement: CompiledSchemaCheck<PreviewMarkElement> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewMarkElement {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewMarkElement.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.elementRef === undefined) && (missing0 = "elementRef")) || ((data.box === undefined) && (missing0 = "box"))) || ((data.snapshotGeneration === undefined) && (missing0 = "snapshotGeneration"))){validatePreviewMarkElement.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "elementRef") || (key0 === "box")) || (key0 === "snapshotGeneration"))){validatePreviewMarkElement.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.elementRef !== undefined){const _errs2: any = errors;if(!(validatePreviewElementRef.call(this, data.elementRef, {instancePath:instancePath+"/elementRef",parentData:data,parentDataProperty:"elementRef",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewElementRef.errors : vErrors.concat(validatePreviewElementRef.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.box !== undefined){const _errs3: any = errors;if(!(validatePreviewRect.call(this, data.box, {instancePath:instancePath+"/box",parentData:data,parentDataProperty:"box",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewRect.errors : vErrors.concat(validatePreviewRect.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.snapshotGeneration !== undefined){let data2: any = data.snapshotGeneration;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validatePreviewMarkElement.errors = [{instancePath:instancePath+"/snapshotGeneration",schemaPath:"#/properties/snapshotGeneration/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validatePreviewMarkElement.errors = [{instancePath:instancePath+"/snapshotGeneration",schemaPath:"#/properties/snapshotGeneration/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validatePreviewMarkElement.errors = [{instancePath:instancePath+"/snapshotGeneration",schemaPath:"#/properties/snapshotGeneration/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePreviewMarkElement.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewMarkElement.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewMarkElement.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema821: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"comment"},"number":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"Its number."},"note":{"type":["string","null"],"minLength":1,"maxLength":4096,"description":"The person's note; `null` where they wrote none."},"point":{"$ref":"#/$defs/PreviewPoint","description":"Where it is pinned, in viewport CSS pixels."},"element":{"anyOf":[{"$ref":"#/$defs/PreviewMarkElement"},{"type":"null"}],"description":"The element it landed on; `null` where it hit none."}},"required":["kind","number","note","point","element"],"description":"A numbered comment pin."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"box"},"number":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"Its number."},"note":{"type":["string","null"],"minLength":1,"maxLength":4096,"description":"The person's note; `null` where they wrote none."},"rect":{"$ref":"#/$defs/PreviewRect","description":"The box."},"element":{"anyOf":[{"$ref":"#/$defs/PreviewMarkElement"},{"type":"null"}],"description":"The element it landed on; `null` where it hit none."}},"required":["kind","number","note","rect","element"],"description":"A numbered box."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"stroke"},"points":{"type":"array","items":{"$ref":"#/$defs/PreviewPoint"},"minItems":1,"description":"Its points in viewport CSS pixels, at least one."},"color":{"$ref":"sidekicks-contracts:color#/$defs/HexColor","description":"Its sRGB color."},"element":{"anyOf":[{"$ref":"#/$defs/PreviewMarkElement"},{"type":"null"}],"description":"The element it landed on; `null` where it hit none."}},"required":["kind","points","color","element"],"description":"An unnumbered freehand stroke."}],"description":"One mark on the frozen picture, tagged on `kind`: a numbered comment pin, a numbered box,\nor an unnumbered freehand stroke.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
/** Checks that a value is a {@link PreviewMark}. */
// prettier-ignore
export const validatePreviewMark: CompiledSchemaCheck<PreviewMark> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewMark {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewMark.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "comment"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.kind === undefined) && (missing0 = "kind")) || ((data.number === undefined) && (missing0 = "number"))) || ((data.note === undefined) && (missing0 = "note"))) || ((data.point === undefined) && (missing0 = "point"))) || ((data.element === undefined) && (missing0 = "element"))){validatePreviewMark.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((key0 === "kind") || (key0 === "number")) || (key0 === "note")) || (key0 === "point")) || (key0 === "element"))){validatePreviewMark.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validatePreviewMark.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("comment" !== data0){validatePreviewMark.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "comment"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.number !== undefined){let data1: any = data.number;const _errs7: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validatePreviewMark.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/0/properties/number/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validatePreviewMark.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/0/properties/number/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validatePreviewMark.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/0/properties/number/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.note !== undefined){let data2: any = data.note;const _errs9: any = errors;if((typeof data2 !== "string") && (data2 !== null)){validatePreviewMark.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/0/properties/note/type",keyword:"type",params:{type: schema821.oneOf[0].properties.note.type}}];return false;}if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) > 4096){validatePreviewMark.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/0/properties/note/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validatePreviewMark.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/0/properties/note/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.point !== undefined){const _errs11: any = errors;if(!(validatePreviewPoint.call(this, data.point, {instancePath:instancePath+"/point",parentData:data,parentDataProperty:"point",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPoint.errors : vErrors.concat(validatePreviewPoint.errors);errors = vErrors.length;}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.element !== undefined){let data4: any = data.element;const _errs12: any = errors;const _errs13: any = errors;let valid3: any = false;const _errs14: any = errors;if(!(validatePreviewMarkElement.call(this, data4, {instancePath:instancePath+"/element",parentData:data,parentDataProperty:"element",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewMarkElement.errors : vErrors.concat(validatePreviewMarkElement.errors);errors = vErrors.length;}var _valid0: any = _errs14 === errors;valid3 = valid3 || _valid0;const _errs15: any = errors;if(data4 !== null){const err0: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/0/properties/element/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs15 === errors;valid3 = valid3 || _valid0;if(!valid3){const err1: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/0/properties/element/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validatePreviewMark.errors = vErrors;return false;}else {errors = _errs13;if(vErrors !== null){if(_errs13){vErrors.length = _errs13;}else {vErrors = null;}}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}}}}}}}}else {validatePreviewMark.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props1: any = true;valid0 = valid1;}else if(tag0 === "box"){const _errs17: any = errors;if(errors === _errs17){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((data.kind === undefined) && (missing1 = "kind")) || ((data.number === undefined) && (missing1 = "number"))) || ((data.note === undefined) && (missing1 = "note"))) || ((data.rect === undefined) && (missing1 = "rect"))) || ((data.element === undefined) && (missing1 = "element"))){validatePreviewMark.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs19: any = errors;for(const key1 in data){if(!(((((key1 === "kind") || (key1 === "number")) || (key1 === "note")) || (key1 === "rect")) || (key1 === "element"))){validatePreviewMark.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs19 === errors){if(data.kind !== undefined){let data5: any = data.kind;const _errs20: any = errors;if(typeof data5 !== "string"){validatePreviewMark.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("box" !== data5){validatePreviewMark.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "box"}}];return false;}var valid5: any = _errs20 === errors;}else {var valid5: any = true;}if(valid5){if(data.number !== undefined){let data6: any = data.number;const _errs22: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validatePreviewMark.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/1/properties/number/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs22){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validatePreviewMark.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/1/properties/number/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 1 || isNaN(data6)){validatePreviewMark.errors = [{instancePath:instancePath+"/number",schemaPath:"#/oneOf/1/properties/number/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid5: any = _errs22 === errors;}else {var valid5: any = true;}if(valid5){if(data.note !== undefined){let data7: any = data.note;const _errs24: any = errors;if((typeof data7 !== "string") && (data7 !== null)){validatePreviewMark.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/1/properties/note/type",keyword:"type",params:{type: schema821.oneOf[1].properties.note.type}}];return false;}if(errors === _errs24){if(typeof data7 === "string"){if(func1(data7) > 4096){validatePreviewMark.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/1/properties/note/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data7) < 1){validatePreviewMark.errors = [{instancePath:instancePath+"/note",schemaPath:"#/oneOf/1/properties/note/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}}var valid5: any = _errs24 === errors;}else {var valid5: any = true;}if(valid5){if(data.rect !== undefined){const _errs26: any = errors;if(!(validatePreviewRect.call(this, data.rect, {instancePath:instancePath+"/rect",parentData:data,parentDataProperty:"rect",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewRect.errors : vErrors.concat(validatePreviewRect.errors);errors = vErrors.length;}var valid5: any = _errs26 === errors;}else {var valid5: any = true;}if(valid5){if(data.element !== undefined){let data9: any = data.element;const _errs27: any = errors;const _errs28: any = errors;let valid6: any = false;const _errs29: any = errors;if(!(validatePreviewMarkElement.call(this, data9, {instancePath:instancePath+"/element",parentData:data,parentDataProperty:"element",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewMarkElement.errors : vErrors.concat(validatePreviewMarkElement.errors);errors = vErrors.length;}var _valid1: any = _errs29 === errors;valid6 = valid6 || _valid1;const _errs30: any = errors;if(data9 !== null){const err2: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/1/properties/element/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid1: any = _errs30 === errors;valid6 = valid6 || _valid1;if(!valid6){const err3: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/1/properties/element/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validatePreviewMark.errors = vErrors;return false;}else {errors = _errs28;if(vErrors !== null){if(_errs28){vErrors.length = _errs28;}else {vErrors = null;}}}var valid5: any = _errs27 === errors;}else {var valid5: any = true;}}}}}}}}else {validatePreviewMark.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs17 === errors;if(props1 !== true){props1 = true;}valid0 = valid4;}else if(tag0 === "stroke"){const _errs32: any = errors;if(errors === _errs32){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((data.kind === undefined) && (missing2 = "kind")) || ((data.points === undefined) && (missing2 = "points"))) || ((data.color === undefined) && (missing2 = "color"))) || ((data.element === undefined) && (missing2 = "element"))){validatePreviewMark.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs34: any = errors;for(const key2 in data){if(!((((key2 === "kind") || (key2 === "points")) || (key2 === "color")) || (key2 === "element"))){validatePreviewMark.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs34 === errors){if(data.kind !== undefined){let data10: any = data.kind;const _errs35: any = errors;if(typeof data10 !== "string"){validatePreviewMark.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("stroke" !== data10){validatePreviewMark.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "stroke"}}];return false;}var valid8: any = _errs35 === errors;}else {var valid8: any = true;}if(valid8){if(data.points !== undefined){let data11: any = data.points;const _errs37: any = errors;if(errors === _errs37){if(Array.isArray(data11)){if(data11.length < 1){validatePreviewMark.errors = [{instancePath:instancePath+"/points",schemaPath:"#/oneOf/2/properties/points/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid9: any = true;const len0: any = data11.length;for(let i0=0; i0<len0; i0++){const _errs39: any = errors;if(!(validatePreviewPoint.call(this, data11[i0], {instancePath:instancePath+"/points/" + i0,parentData:data11,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPoint.errors : vErrors.concat(validatePreviewPoint.errors);errors = vErrors.length;}var valid9: any = _errs39 === errors;if(!valid9){break;}}}}else {validatePreviewMark.errors = [{instancePath:instancePath+"/points",schemaPath:"#/oneOf/2/properties/points/type",keyword:"type",params:{type: "array"}}];return false;}}var valid8: any = _errs37 === errors;}else {var valid8: any = true;}if(valid8){if(data.color !== undefined){const _errs40: any = errors;if(!(validateHexColor.call(this, data.color, {instancePath:instancePath+"/color",parentData:data,parentDataProperty:"color",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateHexColor.errors : vErrors.concat(validateHexColor.errors);errors = vErrors.length;}var valid8: any = _errs40 === errors;}else {var valid8: any = true;}if(valid8){if(data.element !== undefined){let data14: any = data.element;const _errs41: any = errors;const _errs42: any = errors;let valid10: any = false;const _errs43: any = errors;if(!(validatePreviewMarkElement.call(this, data14, {instancePath:instancePath+"/element",parentData:data,parentDataProperty:"element",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewMarkElement.errors : vErrors.concat(validatePreviewMarkElement.errors);errors = vErrors.length;}var _valid2: any = _errs43 === errors;valid10 = valid10 || _valid2;const _errs44: any = errors;if(data14 !== null){const err4: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/2/properties/element/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var _valid2: any = _errs44 === errors;valid10 = valid10 || _valid2;if(!valid10){const err5: any = {instancePath:instancePath+"/element",schemaPath:"#/oneOf/2/properties/element/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validatePreviewMark.errors = vErrors;return false;}else {errors = _errs42;if(vErrors !== null){if(_errs42){vErrors.length = _errs42;}else {vErrors = null;}}}var valid8: any = _errs41 === errors;}else {var valid8: any = true;}}}}}}}else {validatePreviewMark.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs32 === errors;if(props1 !== true){props1 = true;}valid0 = valid7;}else {validatePreviewMark.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validatePreviewMark.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props1 !== true){for(const key3 in data){if(!props1 || !props1[key3]){validatePreviewMark.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validatePreviewMark.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewMark.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewMark.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewMarkSendRequest}. */
// prettier-ignore
export const validatePreviewMarkSendRequest: CompiledSchemaCheck<PreviewMarkSendRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewMarkSendRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewMarkSendRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.image === undefined) && (missing0 = "image"))) || ((data.address === undefined) && (missing0 = "address"))) || ((data.width === undefined) && (missing0 = "width"))) || ((data.marks === undefined) && (missing0 = "marks"))){validatePreviewMarkSendRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "image")) || (key0 === "address")) || (key0 === "width")) || (key0 === "marks"))){validatePreviewMarkSendRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){const _errs3: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.image !== undefined){let data2: any = data.image;const _errs4: any = errors;if(!(validateBytes.call(this, data2, {instancePath:instancePath+"/image",parentData:data,parentDataProperty:"image",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data2 && typeof data2 == "object" && Number.isInteger(data2.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data2.$bytes] instanceof Uint8Array && this.attachments[data2.$bytes].byteLength >= 1)){validatePreviewMarkSendRequest.errors = [{instancePath:instancePath+"/image",schemaPath:"#/properties/image/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data2 && typeof data2 == "object" && Number.isInteger(data2.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data2.$bytes] instanceof Uint8Array && this.attachments[data2.$bytes].byteLength <= 4194300)){validatePreviewMarkSendRequest.errors = [{instancePath:instancePath+"/image",schemaPath:"#/properties/image/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.address !== undefined){let data3: any = data.address;const _errs6: any = errors;if(errors === _errs6){if(typeof data3 === "string"){if(func1(data3) > 2097152){validatePreviewMarkSendRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data3) < 1){validatePreviewMarkSendRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewMarkSendRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.width !== undefined){let data4: any = data.width;const _errs8: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validatePreviewMarkSendRequest.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validatePreviewMarkSendRequest.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 1 || isNaN(data4)){validatePreviewMarkSendRequest.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.marks !== undefined){let data5: any = data.marks;const _errs10: any = errors;if(errors === _errs10){if(Array.isArray(data5)){if(data5.length < 1){validatePreviewMarkSendRequest.errors = [{instancePath:instancePath+"/marks",schemaPath:"#/properties/marks/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data5.length;for(let i0=0; i0<len0; i0++){const _errs12: any = errors;if(!(validatePreviewMark.call(this, data5[i0], {instancePath:instancePath+"/marks/" + i0,parentData:data5,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewMark.errors : vErrors.concat(validatePreviewMark.errors);errors = vErrors.length;}var valid1: any = _errs12 === errors;if(!valid1){break;}}}}else {validatePreviewMarkSendRequest.errors = [{instancePath:instancePath+"/marks",schemaPath:"#/properties/marks/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}}else {validatePreviewMarkSendRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewMarkSendRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewMarkSendRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewMarkSendResponse}. */
// prettier-ignore
export const validatePreviewMarkSendResponse: CompiledSchemaCheck<PreviewMarkSendResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewMarkSendResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewMarkSendResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.staged === undefined) && (missing0 = "staged")){validatePreviewMarkSendResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "staged")){validatePreviewMarkSendResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.staged !== undefined){if(!(validateSessionAttachmentSummary.call(this, data.staged, {instancePath:instancePath+"/staged",parentData:data,parentDataProperty:"staged",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionAttachmentSummary.errors : vErrors.concat(validateSessionAttachmentSummary.errors);errors = vErrors.length;}}}}}else {validatePreviewMarkSendResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewMarkSendResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewMarkSendResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewScreencastSubscribeRequest}. */
// prettier-ignore
export const validatePreviewScreencastSubscribeRequest: CompiledSchemaCheck<PreviewScreencastSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewScreencastSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))){validatePreviewScreencastSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "pageId"))){validatePreviewScreencastSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){const _errs3: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewScreencastSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewScreencastSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewScreencastSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewScreencastFrameMetadata}. */
// prettier-ignore
export const validatePreviewScreencastFrameMetadata: CompiledSchemaCheck<PreviewScreencastFrameMetadata> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastFrameMetadata {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewScreencastFrameMetadata.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.offsetTop === undefined) && (missing0 = "offsetTop")) || ((data.pageScaleFactor === undefined) && (missing0 = "pageScaleFactor"))) || ((data.deviceWidth === undefined) && (missing0 = "deviceWidth"))) || ((data.deviceHeight === undefined) && (missing0 = "deviceHeight"))) || ((data.scrollOffsetX === undefined) && (missing0 = "scrollOffsetX"))) || ((data.scrollOffsetY === undefined) && (missing0 = "scrollOffsetY"))){validatePreviewScreencastFrameMetadata.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "offsetTop") || (key0 === "pageScaleFactor")) || (key0 === "deviceWidth")) || (key0 === "deviceHeight")) || (key0 === "scrollOffsetX")) || (key0 === "scrollOffsetY"))){validatePreviewScreencastFrameMetadata.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.offsetTop !== undefined){let data0: any = data.offsetTop;const _errs2: any = errors;if(!((typeof data0 == "number") && (isFinite(data0)))){validatePreviewScreencastFrameMetadata.errors = [{instancePath:instancePath+"/offsetTop",schemaPath:"#/properties/offsetTop/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageScaleFactor !== undefined){let data1: any = data.pageScaleFactor;const _errs4: any = errors;if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 <= 0 || isNaN(data1)){validatePreviewScreencastFrameMetadata.errors = [{instancePath:instancePath+"/pageScaleFactor",schemaPath:"#/properties/pageScaleFactor/exclusiveMinimum",keyword:"exclusiveMinimum",params:{comparison: ">", limit: 0}}];return false;}}else {validatePreviewScreencastFrameMetadata.errors = [{instancePath:instancePath+"/pageScaleFactor",schemaPath:"#/properties/pageScaleFactor/type",keyword:"type",params:{type: "number"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceWidth !== undefined){let data2: any = data.deviceWidth;const _errs6: any = errors;if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 < 0 || isNaN(data2)){validatePreviewScreencastFrameMetadata.errors = [{instancePath:instancePath+"/deviceWidth",schemaPath:"#/properties/deviceWidth/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}else {validatePreviewScreencastFrameMetadata.errors = [{instancePath:instancePath+"/deviceWidth",schemaPath:"#/properties/deviceWidth/type",keyword:"type",params:{type: "number"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceHeight !== undefined){let data3: any = data.deviceHeight;const _errs8: any = errors;if(errors === _errs8){if((typeof data3 == "number") && (isFinite(data3))){if(data3 < 0 || isNaN(data3)){validatePreviewScreencastFrameMetadata.errors = [{instancePath:instancePath+"/deviceHeight",schemaPath:"#/properties/deviceHeight/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}else {validatePreviewScreencastFrameMetadata.errors = [{instancePath:instancePath+"/deviceHeight",schemaPath:"#/properties/deviceHeight/type",keyword:"type",params:{type: "number"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.scrollOffsetX !== undefined){let data4: any = data.scrollOffsetX;const _errs10: any = errors;if(!((typeof data4 == "number") && (isFinite(data4)))){validatePreviewScreencastFrameMetadata.errors = [{instancePath:instancePath+"/scrollOffsetX",schemaPath:"#/properties/scrollOffsetX/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.scrollOffsetY !== undefined){let data5: any = data.scrollOffsetY;const _errs12: any = errors;if(!((typeof data5 == "number") && (isFinite(data5)))){validatePreviewScreencastFrameMetadata.errors = [{instancePath:instancePath+"/scrollOffsetY",schemaPath:"#/properties/scrollOffsetY/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}}}else {validatePreviewScreencastFrameMetadata.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewScreencastFrameMetadata.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewScreencastFrameMetadata.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewScreencastAcknowledgmentToken}. */
// prettier-ignore
export const validatePreviewScreencastAcknowledgmentToken: CompiledSchemaCheck<PreviewScreencastAcknowledgmentToken> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastAcknowledgmentToken {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewScreencastAcknowledgmentToken.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validatePreviewScreencastAcknowledgmentToken.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePreviewScreencastAcknowledgmentToken.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validatePreviewScreencastAcknowledgmentToken.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewScreencastAcknowledgmentToken.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewInputMessageId}. */
// prettier-ignore
export const validatePreviewInputMessageId: CompiledSchemaCheck<PreviewInputMessageId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewInputMessageId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewInputMessageId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validatePreviewInputMessageId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validatePreviewInputMessageId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewInputMessageId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validatePreviewInputMessageId.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewInputMessageId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewSaveId}. */
// prettier-ignore
export const validatePreviewSaveId: CompiledSchemaCheck<PreviewSaveId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewSaveId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewSaveId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validatePreviewSaveId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validatePreviewSaveId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewSaveId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validatePreviewSaveId.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewSaveId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema854: any = {"description":"What a file chooser lets the device pick.","type":"string","enum":["selectSingle","selectMultiple","selectFolder"]};
/** Checks that a value is a {@link PreviewFileChooserMode}. */
// prettier-ignore
export const validatePreviewFileChooserMode: CompiledSchemaCheck<PreviewFileChooserMode> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewFileChooserMode {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewFileChooserMode.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePreviewFileChooserMode.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "selectSingle") || (data === "selectMultiple")) || (data === "selectFolder"))){validatePreviewFileChooserMode.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema854.enum}}];return false;}validatePreviewFileChooserMode.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewFileChooserMode.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema852: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"frame"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"imageData":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes","minBytes":1,"maxBytes":4194300,"tsType":"Uint8Array","description":"The JPEG."},"metadata":{"$ref":"#/$defs/PreviewScreencastFrameMetadata","description":"What maps its pixels back to the page."},"ackToken":{"$ref":"#/$defs/PreviewScreencastAcknowledgmentToken","description":"The token that acknowledges it."}},"required":["kind","pageId","imageData","metadata","ackToken"],"description":"One frame: a JPEG, what maps its pixels back to page coordinates, and the token the\nwatcher returns to acknowledge it. The stream sends the newest image once the last is\nacknowledged, so a slow watcher sees the page as it is now."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"menu"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"messageId":{"$ref":"#/$defs/PreviewInputMessageId","description":"The input that raised it."},"point":{"$ref":"#/$defs/PreviewPoint","description":"Where it opened, in frame pixels."},"linkUrl":{"type":"string","minLength":1,"maxLength":2097152,"description":"The link under the press."},"isEditable":{"type":"boolean","description":"Whether the press landed in a field that takes text, neither read-only nor\ndisabled."},"canCut":{"type":"boolean","description":"Whether the page allows a cut there."},"canCopy":{"type":"boolean","description":"Whether the page allows a copy there."},"selectionText":{"type":"string","description":"The selected text; absent where the page allows no copy, as in a password field."}},"required":["kind","pageId","messageId","point","isEditable","canCut","canCopy"],"description":"The page's right-click menu, sent when the page leaves a device's menu uncanceled."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"fileChooser"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"messageId":{"$ref":"#/$defs/PreviewInputMessageId","description":"The input that opened it."},"mode":{"$ref":"#/$defs/PreviewFileChooserMode","description":"What it lets the device pick."},"accept":{"type":"string","minLength":1,"description":"The input's own `accept`, or a picker's types where it excludes every other file,\nwhich the device's picker honors."}},"required":["kind","pageId","messageId","mode"],"description":"A file chooser or a File System Access picker a device's press or key opened; the\ndevice opens its own picker."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"save"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"messageId":{"$ref":"#/$defs/PreviewInputMessageId","description":"The press or key that started a download; absent for a picker's write."},"saveId":{"$ref":"#/$defs/PreviewSaveId","description":"The save."},"fileName":{"type":"string","minLength":1,"maxLength":4096,"description":"The file's name, which the device cleans as the daemon cleans a staged name."},"folderPath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file's path inside a folder the device picked."},"size":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Its size in bytes."},"isHeld":{"type":"boolean","description":"Whether it was held while the device was away; the device asks before saving it."}},"required":["kind","pageId","saveId","fileName","size","isHeld"],"description":"A file the page saved for this device: a download its press or key started, or a write\nthe page finished through a handle its picker gave. Its bytes follow as `savePart`\nelements, one save at a time; a save held while the device had no stream is sent again,\nwhole, when it opens Preview on the session again."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"savePart"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"saveId":{"$ref":"#/$defs/PreviewSaveId","description":"The save."},"part":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes","minBytes":1,"maxBytes":262144,"tsType":"Uint8Array","description":"This part's bytes."},"isLastPart":{"type":"boolean","description":"Whether the file ends with this part."}},"required":["kind","pageId","saveId","part","isLastPart"],"description":"One part of a save. A device that loses its stream before the last part throws the\nsave away."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"downloadRefused"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."}},"required":["kind","pageId"],"description":"A download on this page no person started, an agent's click or a workflow step; the\npane reads `Downloads are off in Preview`."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"saveCanceled"},"pageId":{"$ref":"#/$defs/PreviewPageId","description":"The page."},"fileName":{"type":"string","minLength":1,"maxLength":4096,"description":"The file's name."}},"required":["kind","pageId","fileName"],"description":"A save canceled because staging it would leave the staging folder's volume under 2 GiB\nfree; the pane reads that the machine is low on disk space."}],"description":"One element of a page's live picture, tagged on `kind`. A menu, a file chooser and a\ndownload name the `messageId` of the device's input that raised them, so the device knows\nwhich of its presses each answers.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link PreviewScreencastElement}. */
// prettier-ignore
export const validatePreviewScreencastElement: CompiledSchemaCheck<PreviewScreencastElement> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastElement {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewScreencastElement.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "frame"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.kind === undefined) && (missing0 = "kind")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.imageData === undefined) && (missing0 = "imageData"))) || ((data.metadata === undefined) && (missing0 = "metadata"))) || ((data.ackToken === undefined) && (missing0 = "ackToken"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((key0 === "kind") || (key0 === "pageId")) || (key0 === "imageData")) || (key0 === "metadata")) || (key0 === "ackToken"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("frame" !== data0){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "frame"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.pageId !== undefined){const _errs7: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.imageData !== undefined){let data2: any = data.imageData;const _errs8: any = errors;if(!(validateBytes.call(this, data2, {instancePath:instancePath+"/imageData",parentData:data,parentDataProperty:"imageData",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data2 && typeof data2 == "object" && Number.isInteger(data2.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data2.$bytes] instanceof Uint8Array && this.attachments[data2.$bytes].byteLength >= 1)){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/imageData",schemaPath:"#/oneOf/0/properties/imageData/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data2 && typeof data2 == "object" && Number.isInteger(data2.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data2.$bytes] instanceof Uint8Array && this.attachments[data2.$bytes].byteLength <= 4194300)){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/imageData",schemaPath:"#/oneOf/0/properties/imageData/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.metadata !== undefined){const _errs10: any = errors;if(!(validatePreviewScreencastFrameMetadata.call(this, data.metadata, {instancePath:instancePath+"/metadata",parentData:data,parentDataProperty:"metadata",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewScreencastFrameMetadata.errors : vErrors.concat(validatePreviewScreencastFrameMetadata.errors);errors = vErrors.length;}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.ackToken !== undefined){const _errs11: any = errors;if(!(validatePreviewScreencastAcknowledgmentToken.call(this, data.ackToken, {instancePath:instancePath+"/ackToken",parentData:data,parentDataProperty:"ackToken",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewScreencastAcknowledgmentToken.errors : vErrors.concat(validatePreviewScreencastAcknowledgmentToken.errors);errors = vErrors.length;}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}}}}}}}}else {validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "menu"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((((data.kind === undefined) && (missing1 = "kind")) || ((data.pageId === undefined) && (missing1 = "pageId"))) || ((data.messageId === undefined) && (missing1 = "messageId"))) || ((data.point === undefined) && (missing1 = "point"))) || ((data.isEditable === undefined) && (missing1 = "isEditable"))) || ((data.canCut === undefined) && (missing1 = "canCut"))) || ((data.canCopy === undefined) && (missing1 = "canCopy"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data){if(!(func2.call(schema852.oneOf[1].properties, key1))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data5: any = data.kind;const _errs15: any = errors;if(typeof data5 !== "string"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("menu" !== data5){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "menu"}}];return false;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data.pageId !== undefined){const _errs17: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid4: any = _errs17 === errors;}else {var valid4: any = true;}if(valid4){if(data.messageId !== undefined){const _errs18: any = errors;if(!(validatePreviewInputMessageId.call(this, data.messageId, {instancePath:instancePath+"/messageId",parentData:data,parentDataProperty:"messageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewInputMessageId.errors : vErrors.concat(validatePreviewInputMessageId.errors);errors = vErrors.length;}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.point !== undefined){const _errs19: any = errors;if(!(validatePreviewPoint.call(this, data.point, {instancePath:instancePath+"/point",parentData:data,parentDataProperty:"point",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPoint.errors : vErrors.concat(validatePreviewPoint.errors);errors = vErrors.length;}var valid4: any = _errs19 === errors;}else {var valid4: any = true;}if(valid4){if(data.linkUrl !== undefined){let data9: any = data.linkUrl;const _errs20: any = errors;if(errors === _errs20){if(typeof data9 === "string"){if(func1(data9) > 2097152){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/oneOf/1/properties/linkUrl/maxLength",keyword:"maxLength",params:{limit: 2097152}}];return false;}else {if(func1(data9) < 1){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/oneOf/1/properties/linkUrl/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/linkUrl",schemaPath:"#/oneOf/1/properties/linkUrl/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}if(valid4){if(data.isEditable !== undefined){const _errs22: any = errors;if(typeof data.isEditable !== "boolean"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/isEditable",schemaPath:"#/oneOf/1/properties/isEditable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs22 === errors;}else {var valid4: any = true;}if(valid4){if(data.canCut !== undefined){const _errs24: any = errors;if(typeof data.canCut !== "boolean"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/canCut",schemaPath:"#/oneOf/1/properties/canCut/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs24 === errors;}else {var valid4: any = true;}if(valid4){if(data.canCopy !== undefined){const _errs26: any = errors;if(typeof data.canCopy !== "boolean"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/canCopy",schemaPath:"#/oneOf/1/properties/canCopy/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs26 === errors;}else {var valid4: any = true;}if(valid4){if(data.selectionText !== undefined){const _errs28: any = errors;if(typeof data.selectionText !== "string"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/selectionText",schemaPath:"#/oneOf/1/properties/selectionText/type",keyword:"type",params:{type: "string"}}];return false;}var valid4: any = _errs28 === errors;}else {var valid4: any = true;}}}}}}}}}}}}else {validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs12 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "fileChooser"){const _errs30: any = errors;if(errors === _errs30){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((data.kind === undefined) && (missing2 = "kind")) || ((data.pageId === undefined) && (missing2 = "pageId"))) || ((data.messageId === undefined) && (missing2 = "messageId"))) || ((data.mode === undefined) && (missing2 = "mode"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs32: any = errors;for(const key2 in data){if(!(((((key2 === "kind") || (key2 === "pageId")) || (key2 === "messageId")) || (key2 === "mode")) || (key2 === "accept"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs32 === errors){if(data.kind !== undefined){let data14: any = data.kind;const _errs33: any = errors;if(typeof data14 !== "string"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("fileChooser" !== data14){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "fileChooser"}}];return false;}var valid6: any = _errs33 === errors;}else {var valid6: any = true;}if(valid6){if(data.pageId !== undefined){const _errs35: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid6: any = _errs35 === errors;}else {var valid6: any = true;}if(valid6){if(data.messageId !== undefined){const _errs36: any = errors;if(!(validatePreviewInputMessageId.call(this, data.messageId, {instancePath:instancePath+"/messageId",parentData:data,parentDataProperty:"messageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewInputMessageId.errors : vErrors.concat(validatePreviewInputMessageId.errors);errors = vErrors.length;}var valid6: any = _errs36 === errors;}else {var valid6: any = true;}if(valid6){if(data.mode !== undefined){const _errs37: any = errors;if(!(validatePreviewFileChooserMode.call(this, data.mode, {instancePath:instancePath+"/mode",parentData:data,parentDataProperty:"mode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewFileChooserMode.errors : vErrors.concat(validatePreviewFileChooserMode.errors);errors = vErrors.length;}var valid6: any = _errs37 === errors;}else {var valid6: any = true;}if(valid6){if(data.accept !== undefined){let data18: any = data.accept;const _errs38: any = errors;if(errors === _errs38){if(typeof data18 === "string"){if(func1(data18) < 1){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/accept",schemaPath:"#/oneOf/2/properties/accept/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/accept",schemaPath:"#/oneOf/2/properties/accept/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs38 === errors;}else {var valid6: any = true;}}}}}}}}else {validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs30 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else if(tag0 === "save"){const _errs40: any = errors;if(errors === _errs40){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((((data.kind === undefined) && (missing3 = "kind")) || ((data.pageId === undefined) && (missing3 = "pageId"))) || ((data.saveId === undefined) && (missing3 = "saveId"))) || ((data.fileName === undefined) && (missing3 = "fileName"))) || ((data.size === undefined) && (missing3 = "size"))) || ((data.isHeld === undefined) && (missing3 = "isHeld"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs42: any = errors;for(const key3 in data){if(!((((((((key3 === "kind") || (key3 === "pageId")) || (key3 === "messageId")) || (key3 === "saveId")) || (key3 === "fileName")) || (key3 === "folderPath")) || (key3 === "size")) || (key3 === "isHeld"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs42 === errors){if(data.kind !== undefined){let data19: any = data.kind;const _errs43: any = errors;if(typeof data19 !== "string"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("save" !== data19){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "save"}}];return false;}var valid8: any = _errs43 === errors;}else {var valid8: any = true;}if(valid8){if(data.pageId !== undefined){const _errs45: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid8: any = _errs45 === errors;}else {var valid8: any = true;}if(valid8){if(data.messageId !== undefined){const _errs46: any = errors;if(!(validatePreviewInputMessageId.call(this, data.messageId, {instancePath:instancePath+"/messageId",parentData:data,parentDataProperty:"messageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewInputMessageId.errors : vErrors.concat(validatePreviewInputMessageId.errors);errors = vErrors.length;}var valid8: any = _errs46 === errors;}else {var valid8: any = true;}if(valid8){if(data.saveId !== undefined){const _errs47: any = errors;if(!(validatePreviewSaveId.call(this, data.saveId, {instancePath:instancePath+"/saveId",parentData:data,parentDataProperty:"saveId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewSaveId.errors : vErrors.concat(validatePreviewSaveId.errors);errors = vErrors.length;}var valid8: any = _errs47 === errors;}else {var valid8: any = true;}if(valid8){if(data.fileName !== undefined){let data23: any = data.fileName;const _errs48: any = errors;if(errors === _errs48){if(typeof data23 === "string"){if(func1(data23) > 4096){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/3/properties/fileName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data23) < 1){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/3/properties/fileName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/3/properties/fileName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs48 === errors;}else {var valid8: any = true;}if(valid8){if(data.folderPath !== undefined){let data24: any = data.folderPath;const _errs50: any = errors;if(errors === _errs50){if(typeof data24 === "string"){if(func1(data24) > 4096){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/oneOf/3/properties/folderPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data24) < 1){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/oneOf/3/properties/folderPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data24)){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/oneOf/3/properties/folderPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/oneOf/3/properties/folderPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs50 === errors;}else {var valid8: any = true;}if(valid8){if(data.size !== undefined){let data25: any = data.size;const _errs52: any = errors;if(!(((typeof data25 == "number") && (!(data25 % 1) && !isNaN(data25))) && (isFinite(data25)))){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/size",schemaPath:"#/oneOf/3/properties/size/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs52){if((typeof data25 == "number") && (isFinite(data25))){if(data25 > 9007199254740991 || isNaN(data25)){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/size",schemaPath:"#/oneOf/3/properties/size/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data25 < 0 || isNaN(data25)){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/size",schemaPath:"#/oneOf/3/properties/size/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid8: any = _errs52 === errors;}else {var valid8: any = true;}if(valid8){if(data.isHeld !== undefined){const _errs54: any = errors;if(typeof data.isHeld !== "boolean"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/isHeld",schemaPath:"#/oneOf/3/properties/isHeld/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid8: any = _errs54 === errors;}else {var valid8: any = true;}}}}}}}}}}}else {validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs40 === errors;if(props0 !== true){props0 = true;}valid0 = valid7;}else if(tag0 === "savePart"){const _errs56: any = errors;if(errors === _errs56){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((((data.kind === undefined) && (missing4 = "kind")) || ((data.pageId === undefined) && (missing4 = "pageId"))) || ((data.saveId === undefined) && (missing4 = "saveId"))) || ((data.part === undefined) && (missing4 = "part"))) || ((data.isLastPart === undefined) && (missing4 = "isLastPart"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs58: any = errors;for(const key4 in data){if(!(((((key4 === "kind") || (key4 === "pageId")) || (key4 === "saveId")) || (key4 === "part")) || (key4 === "isLastPart"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs58 === errors){if(data.kind !== undefined){let data27: any = data.kind;const _errs59: any = errors;if(typeof data27 !== "string"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("savePart" !== data27){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "savePart"}}];return false;}var valid10: any = _errs59 === errors;}else {var valid10: any = true;}if(valid10){if(data.pageId !== undefined){const _errs61: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid10: any = _errs61 === errors;}else {var valid10: any = true;}if(valid10){if(data.saveId !== undefined){const _errs62: any = errors;if(!(validatePreviewSaveId.call(this, data.saveId, {instancePath:instancePath+"/saveId",parentData:data,parentDataProperty:"saveId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewSaveId.errors : vErrors.concat(validatePreviewSaveId.errors);errors = vErrors.length;}var valid10: any = _errs62 === errors;}else {var valid10: any = true;}if(valid10){if(data.part !== undefined){let data30: any = data.part;const _errs63: any = errors;if(!(validateBytes.call(this, data30, {instancePath:instancePath+"/part",parentData:data,parentDataProperty:"part",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data30 && typeof data30 == "object" && Number.isInteger(data30.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data30.$bytes] instanceof Uint8Array && this.attachments[data30.$bytes].byteLength >= 1)){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/part",schemaPath:"#/oneOf/4/properties/part/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data30 && typeof data30 == "object" && Number.isInteger(data30.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data30.$bytes] instanceof Uint8Array && this.attachments[data30.$bytes].byteLength <= 262144)){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/part",schemaPath:"#/oneOf/4/properties/part/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid10: any = _errs63 === errors;}else {var valid10: any = true;}if(valid10){if(data.isLastPart !== undefined){const _errs65: any = errors;if(typeof data.isLastPart !== "boolean"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/isLastPart",schemaPath:"#/oneOf/4/properties/isLastPart/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid10: any = _errs65 === errors;}else {var valid10: any = true;}}}}}}}}else {validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs56 === errors;if(props0 !== true){props0 = true;}valid0 = valid9;}else if(tag0 === "downloadRefused"){const _errs67: any = errors;if(errors === _errs67){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if(((data.kind === undefined) && (missing5 = "kind")) || ((data.pageId === undefined) && (missing5 = "pageId"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs69: any = errors;for(const key5 in data){if(!((key5 === "kind") || (key5 === "pageId"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs69 === errors){if(data.kind !== undefined){let data32: any = data.kind;const _errs70: any = errors;if(typeof data32 !== "string"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("downloadRefused" !== data32){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/5/properties/kind/const",keyword:"const",params:{allowedValue: "downloadRefused"}}];return false;}var valid12: any = _errs70 === errors;}else {var valid12: any = true;}if(valid12){if(data.pageId !== undefined){const _errs72: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid12: any = _errs72 === errors;}else {var valid12: any = true;}}}}}else {validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}var valid11: any = _errs67 === errors;if(props0 !== true){props0 = true;}valid0 = valid11;}else if(tag0 === "saveCanceled"){const _errs73: any = errors;if(errors === _errs73){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if((((data.kind === undefined) && (missing6 = "kind")) || ((data.pageId === undefined) && (missing6 = "pageId"))) || ((data.fileName === undefined) && (missing6 = "fileName"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/6/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs75: any = errors;for(const key6 in data){if(!(((key6 === "kind") || (key6 === "pageId")) || (key6 === "fileName"))){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs75 === errors){if(data.kind !== undefined){let data34: any = data.kind;const _errs76: any = errors;if(typeof data34 !== "string"){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("saveCanceled" !== data34){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/6/properties/kind/const",keyword:"const",params:{allowedValue: "saveCanceled"}}];return false;}var valid14: any = _errs76 === errors;}else {var valid14: any = true;}if(valid14){if(data.pageId !== undefined){const _errs78: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid14: any = _errs78 === errors;}else {var valid14: any = true;}if(valid14){if(data.fileName !== undefined){let data36: any = data.fileName;const _errs79: any = errors;if(errors === _errs79){if(typeof data36 === "string"){if(func1(data36) > 4096){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/6/properties/fileName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data36) < 1){validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/6/properties/fileName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewScreencastElement.errors = [{instancePath:instancePath+"/fileName",schemaPath:"#/oneOf/6/properties/fileName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid14: any = _errs79 === errors;}else {var valid14: any = true;}}}}}}else {validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/oneOf/6/type",keyword:"type",params:{type: "object"}}];return false;}}var valid13: any = _errs73 === errors;if(props0 !== true){props0 = true;}valid0 = valid13;}else {validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key7 in data){if(!props0 || !props0[key7]){validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key7}}];return false;break;}}}}}else {validatePreviewScreencastElement.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewScreencastElement.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewScreencastElement.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewScreencastAcknowledgeRequest}. */
// prettier-ignore
export const validatePreviewScreencastAcknowledgeRequest: CompiledSchemaCheck<PreviewScreencastAcknowledgeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastAcknowledgeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewScreencastAcknowledgeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.ackToken === undefined) && (missing0 = "ackToken"))){validatePreviewScreencastAcknowledgeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "ackToken"))){validatePreviewScreencastAcknowledgeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){const _errs3: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.ackToken !== undefined){const _errs4: any = errors;if(!(validatePreviewScreencastAcknowledgmentToken.call(this, data.ackToken, {instancePath:instancePath+"/ackToken",parentData:data,parentDataProperty:"ackToken",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewScreencastAcknowledgmentToken.errors : vErrors.concat(validatePreviewScreencastAcknowledgmentToken.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePreviewScreencastAcknowledgeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewScreencastAcknowledgeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewScreencastAcknowledgeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema860: any = {"description":"What a mouse input does.","type":"string","enum":["press","move","release"]};
/** Checks that a value is a {@link PreviewMouseAction}. */
// prettier-ignore
export const validatePreviewMouseAction: CompiledSchemaCheck<PreviewMouseAction> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewMouseAction {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewMouseAction.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePreviewMouseAction.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "press") || (data === "move")) || (data === "release"))){validatePreviewMouseAction.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema860.enum}}];return false;}validatePreviewMouseAction.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewMouseAction.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema861: any = {"description":"The mouse button an input names.","type":"string","enum":["none","left","middle","right"]};
/** Checks that a value is a {@link PreviewMouseButton}. */
// prettier-ignore
export const validatePreviewMouseButton: CompiledSchemaCheck<PreviewMouseButton> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewMouseButton {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewMouseButton.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePreviewMouseButton.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "none") || (data === "left")) || (data === "middle")) || (data === "right"))){validatePreviewMouseButton.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema861.enum}}];return false;}validatePreviewMouseButton.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewMouseButton.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema862: any = {"description":"What a touch input does.","type":"string","enum":["start","move","end","cancel"]};
/** Checks that a value is a {@link PreviewTouchAction}. */
// prettier-ignore
export const validatePreviewTouchAction: CompiledSchemaCheck<PreviewTouchAction> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewTouchAction {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewTouchAction.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePreviewTouchAction.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "start") || (data === "move")) || (data === "end")) || (data === "cancel"))){validatePreviewTouchAction.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema862.enum}}];return false;}validatePreviewTouchAction.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewTouchAction.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewTouchPoint}. */
// prettier-ignore
export const validatePreviewTouchPoint: CompiledSchemaCheck<PreviewTouchPoint> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewTouchPoint {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewTouchPoint.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.x === undefined) && (missing0 = "x")) || ((data.y === undefined) && (missing0 = "y"))) || ((data.id === undefined) && (missing0 = "id"))){validatePreviewTouchPoint.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "x") || (key0 === "y")) || (key0 === "id"))){validatePreviewTouchPoint.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.x !== undefined){let data0: any = data.x;const _errs2: any = errors;if(!((typeof data0 == "number") && (isFinite(data0)))){validatePreviewTouchPoint.errors = [{instancePath:instancePath+"/x",schemaPath:"#/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.y !== undefined){let data1: any = data.y;const _errs4: any = errors;if(!((typeof data1 == "number") && (isFinite(data1)))){validatePreviewTouchPoint.errors = [{instancePath:instancePath+"/y",schemaPath:"#/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.id !== undefined){let data2: any = data.id;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validatePreviewTouchPoint.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validatePreviewTouchPoint.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validatePreviewTouchPoint.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validatePreviewTouchPoint.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewTouchPoint.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewTouchPoint.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema864: any = {"description":"What a key input does.","type":"string","enum":["down","up"]};
/** Checks that a value is a {@link PreviewKeyAction}. */
// prettier-ignore
export const validatePreviewKeyAction: CompiledSchemaCheck<PreviewKeyAction> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewKeyAction {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewKeyAction.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePreviewKeyAction.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "down") || (data === "up"))){validatePreviewKeyAction.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema864.enum}}];return false;}validatePreviewKeyAction.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewKeyAction.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewDeviceInput}. */
// prettier-ignore
export const validatePreviewDeviceInput: CompiledSchemaCheck<PreviewDeviceInput> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewDeviceInput {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewDeviceInput.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "mouse"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.type === undefined) && (missing0 = "type"))) || ((data.x === undefined) && (missing0 = "x"))) || ((data.y === undefined) && (missing0 = "y"))) || ((data.button === undefined) && (missing0 = "button"))) || ((data.clickCount === undefined) && (missing0 = "clickCount"))) || ((data.modifiers === undefined) && (missing0 = "modifiers"))){validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((((key0 === "kind") || (key0 === "type")) || (key0 === "x")) || (key0 === "y")) || (key0 === "button")) || (key0 === "clickCount")) || (key0 === "modifiers"))){validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("mouse" !== data0){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "mouse"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.type !== undefined){const _errs7: any = errors;if(!(validatePreviewMouseAction.call(this, data.type, {instancePath:instancePath+"/type",parentData:data,parentDataProperty:"type",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewMouseAction.errors : vErrors.concat(validatePreviewMouseAction.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.x !== undefined){let data2: any = data.x;const _errs8: any = errors;if(!((typeof data2 == "number") && (isFinite(data2)))){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/x",schemaPath:"#/oneOf/0/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.y !== undefined){let data3: any = data.y;const _errs10: any = errors;if(!((typeof data3 == "number") && (isFinite(data3)))){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/y",schemaPath:"#/oneOf/0/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.button !== undefined){const _errs12: any = errors;if(!(validatePreviewMouseButton.call(this, data.button, {instancePath:instancePath+"/button",parentData:data,parentDataProperty:"button",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewMouseButton.errors : vErrors.concat(validatePreviewMouseButton.errors);errors = vErrors.length;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.clickCount !== undefined){let data5: any = data.clickCount;const _errs13: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/clickCount",schemaPath:"#/oneOf/0/properties/clickCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/clickCount",schemaPath:"#/oneOf/0/properties/clickCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/clickCount",schemaPath:"#/oneOf/0/properties/clickCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.modifiers !== undefined){let data6: any = data.modifiers;const _errs15: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/0/properties/modifiers/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 15 || isNaN(data6)){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/0/properties/modifiers/maximum",keyword:"maximum",params:{comparison: "<=", limit: 15}}];return false;}else {if(data6 < 0 || isNaN(data6)){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/0/properties/modifiers/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}}}}}}}}}}else {validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "wheel"){const _errs17: any = errors;if(errors === _errs17){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((((data.kind === undefined) && (missing1 = "kind")) || ((data.x === undefined) && (missing1 = "x"))) || ((data.y === undefined) && (missing1 = "y"))) || ((data.deltaX === undefined) && (missing1 = "deltaX"))) || ((data.deltaY === undefined) && (missing1 = "deltaY"))) || ((data.modifiers === undefined) && (missing1 = "modifiers"))){validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs19: any = errors;for(const key1 in data){if(!((((((key1 === "kind") || (key1 === "x")) || (key1 === "y")) || (key1 === "deltaX")) || (key1 === "deltaY")) || (key1 === "modifiers"))){validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs19 === errors){if(data.kind !== undefined){let data7: any = data.kind;const _errs20: any = errors;if(typeof data7 !== "string"){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("wheel" !== data7){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "wheel"}}];return false;}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}if(valid4){if(data.x !== undefined){let data8: any = data.x;const _errs22: any = errors;if(!((typeof data8 == "number") && (isFinite(data8)))){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/x",schemaPath:"#/oneOf/1/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid4: any = _errs22 === errors;}else {var valid4: any = true;}if(valid4){if(data.y !== undefined){let data9: any = data.y;const _errs24: any = errors;if(!((typeof data9 == "number") && (isFinite(data9)))){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/y",schemaPath:"#/oneOf/1/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid4: any = _errs24 === errors;}else {var valid4: any = true;}if(valid4){if(data.deltaX !== undefined){let data10: any = data.deltaX;const _errs26: any = errors;if(!((typeof data10 == "number") && (isFinite(data10)))){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/deltaX",schemaPath:"#/oneOf/1/properties/deltaX/type",keyword:"type",params:{type: "number"}}];return false;}var valid4: any = _errs26 === errors;}else {var valid4: any = true;}if(valid4){if(data.deltaY !== undefined){let data11: any = data.deltaY;const _errs28: any = errors;if(!((typeof data11 == "number") && (isFinite(data11)))){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/deltaY",schemaPath:"#/oneOf/1/properties/deltaY/type",keyword:"type",params:{type: "number"}}];return false;}var valid4: any = _errs28 === errors;}else {var valid4: any = true;}if(valid4){if(data.modifiers !== undefined){let data12: any = data.modifiers;const _errs30: any = errors;if(!(((typeof data12 == "number") && (!(data12 % 1) && !isNaN(data12))) && (isFinite(data12)))){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/1/properties/modifiers/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs30){if((typeof data12 == "number") && (isFinite(data12))){if(data12 > 15 || isNaN(data12)){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/1/properties/modifiers/maximum",keyword:"maximum",params:{comparison: "<=", limit: 15}}];return false;}else {if(data12 < 0 || isNaN(data12)){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/1/properties/modifiers/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid4: any = _errs30 === errors;}else {var valid4: any = true;}}}}}}}}}else {validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs17 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "touch"){const _errs32: any = errors;if(errors === _errs32){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.kind === undefined) && (missing2 = "kind")) || ((data.type === undefined) && (missing2 = "type"))) || ((data.points === undefined) && (missing2 = "points"))){validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs34: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "type")) || (key2 === "points"))){validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs34 === errors){if(data.kind !== undefined){let data13: any = data.kind;const _errs35: any = errors;if(typeof data13 !== "string"){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("touch" !== data13){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "touch"}}];return false;}var valid6: any = _errs35 === errors;}else {var valid6: any = true;}if(valid6){if(data.type !== undefined){const _errs37: any = errors;if(!(validatePreviewTouchAction.call(this, data.type, {instancePath:instancePath+"/type",parentData:data,parentDataProperty:"type",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewTouchAction.errors : vErrors.concat(validatePreviewTouchAction.errors);errors = vErrors.length;}var valid6: any = _errs37 === errors;}else {var valid6: any = true;}if(valid6){if(data.points !== undefined){let data15: any = data.points;const _errs38: any = errors;if(errors === _errs38){if(Array.isArray(data15)){var valid7: any = true;const len0: any = data15.length;for(let i0=0; i0<len0; i0++){const _errs40: any = errors;if(!(validatePreviewTouchPoint.call(this, data15[i0], {instancePath:instancePath+"/points/" + i0,parentData:data15,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewTouchPoint.errors : vErrors.concat(validatePreviewTouchPoint.errors);errors = vErrors.length;}var valid7: any = _errs40 === errors;if(!valid7){break;}}}else {validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/points",schemaPath:"#/oneOf/2/properties/points/type",keyword:"type",params:{type: "array"}}];return false;}}var valid6: any = _errs38 === errors;}else {var valid6: any = true;}}}}}}else {validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs32 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else if(tag0 === "key"){const _errs41: any = errors;if(errors === _errs41){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((((((data.kind === undefined) && (missing3 = "kind")) || ((data.type === undefined) && (missing3 = "type"))) || ((data.key === undefined) && (missing3 = "key"))) || ((data.code === undefined) && (missing3 = "code"))) || ((data.modifiers === undefined) && (missing3 = "modifiers"))){validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs43: any = errors;for(const key3 in data){if(!((((((key3 === "kind") || (key3 === "type")) || (key3 === "key")) || (key3 === "code")) || (key3 === "text")) || (key3 === "modifiers"))){validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs43 === errors){if(data.kind !== undefined){let data17: any = data.kind;const _errs44: any = errors;if(typeof data17 !== "string"){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("key" !== data17){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "key"}}];return false;}var valid9: any = _errs44 === errors;}else {var valid9: any = true;}if(valid9){if(data.type !== undefined){const _errs46: any = errors;if(!(validatePreviewKeyAction.call(this, data.type, {instancePath:instancePath+"/type",parentData:data,parentDataProperty:"type",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewKeyAction.errors : vErrors.concat(validatePreviewKeyAction.errors);errors = vErrors.length;}var valid9: any = _errs46 === errors;}else {var valid9: any = true;}if(valid9){if(data.key !== undefined){let data19: any = data.key;const _errs47: any = errors;if(errors === _errs47){if(typeof data19 === "string"){if(func1(data19) < 1){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/key",schemaPath:"#/oneOf/3/properties/key/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/key",schemaPath:"#/oneOf/3/properties/key/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs47 === errors;}else {var valid9: any = true;}if(valid9){if(data.code !== undefined){const _errs49: any = errors;if(typeof data.code !== "string"){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/code",schemaPath:"#/oneOf/3/properties/code/type",keyword:"type",params:{type: "string"}}];return false;}var valid9: any = _errs49 === errors;}else {var valid9: any = true;}if(valid9){if(data.text !== undefined){let data21: any = data.text;const _errs51: any = errors;if(errors === _errs51){if(typeof data21 === "string"){if(func1(data21) < 1){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/text",schemaPath:"#/oneOf/3/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/text",schemaPath:"#/oneOf/3/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs51 === errors;}else {var valid9: any = true;}if(valid9){if(data.modifiers !== undefined){let data22: any = data.modifiers;const _errs53: any = errors;if(!(((typeof data22 == "number") && (!(data22 % 1) && !isNaN(data22))) && (isFinite(data22)))){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/3/properties/modifiers/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs53){if((typeof data22 == "number") && (isFinite(data22))){if(data22 > 15 || isNaN(data22)){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/3/properties/modifiers/maximum",keyword:"maximum",params:{comparison: "<=", limit: 15}}];return false;}else {if(data22 < 0 || isNaN(data22)){validatePreviewDeviceInput.errors = [{instancePath:instancePath+"/modifiers",schemaPath:"#/oneOf/3/properties/modifiers/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid9: any = _errs53 === errors;}else {var valid9: any = true;}}}}}}}}}else {validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid8: any = _errs41 === errors;if(props0 !== true){props0 = true;}valid0 = valid8;}else {validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key4 in data){if(!props0 || !props0[key4]){validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key4}}];return false;break;}}}}}else {validatePreviewDeviceInput.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewDeviceInput.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewDeviceInput.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewScreencastInputSendRequest}. */
// prettier-ignore
export const validatePreviewScreencastInputSendRequest: CompiledSchemaCheck<PreviewScreencastInputSendRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastInputSendRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewScreencastInputSendRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.input === undefined) && (missing0 = "input"))){validatePreviewScreencastInputSendRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "input"))){validatePreviewScreencastInputSendRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){const _errs3: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.input !== undefined){const _errs4: any = errors;if(!(validatePreviewDeviceInput.call(this, data.input, {instancePath:instancePath+"/input",parentData:data,parentDataProperty:"input",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewDeviceInput.errors : vErrors.concat(validatePreviewDeviceInput.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePreviewScreencastInputSendRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewScreencastInputSendRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewScreencastInputSendRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewScreencastInputSendResponse}. */
// prettier-ignore
export const validatePreviewScreencastInputSendResponse: CompiledSchemaCheck<PreviewScreencastInputSendResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastInputSendResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewScreencastInputSendResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.messageId === undefined) && (missing0 = "messageId")){validatePreviewScreencastInputSendResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "messageId")){validatePreviewScreencastInputSendResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.messageId !== undefined){if(!(validatePreviewInputMessageId.call(this, data.messageId, {instancePath:instancePath+"/messageId",parentData:data,parentDataProperty:"messageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewInputMessageId.errors : vErrors.concat(validatePreviewInputMessageId.errors);errors = vErrors.length;}}}}}else {validatePreviewScreencastInputSendResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewScreencastInputSendResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewScreencastInputSendResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewMenuEdit}. */
// prettier-ignore
export const validatePreviewMenuEdit: CompiledSchemaCheck<PreviewMenuEdit> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewMenuEdit {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewMenuEdit.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "paste"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.text === undefined) && (missing0 = "text"))){validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "kind") || (key0 === "text"))){validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validatePreviewMenuEdit.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("paste" !== data0){validatePreviewMenuEdit.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "paste"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.text !== undefined){const _errs7: any = errors;if(typeof data.text !== "string"){validatePreviewMenuEdit.errors = [{instancePath:instancePath+"/text",schemaPath:"#/oneOf/0/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "selectAll"){const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.kind === undefined) && (missing1 = "kind")){validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key1 in data){if(!(key1 === "kind")){validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs11 === errors){if(data.kind !== undefined){let data2: any = data.kind;if(typeof data2 !== "string"){validatePreviewMenuEdit.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("selectAll" !== data2){validatePreviewMenuEdit.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "selectAll"}}];return false;}}}}}else {validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs9 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "cut"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.kind === undefined) && (missing2 = "kind")){validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs16: any = errors;for(const key2 in data){if(!(key2 === "kind")){validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs16 === errors){if(data.kind !== undefined){let data3: any = data.kind;if(typeof data3 !== "string"){validatePreviewMenuEdit.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("cut" !== data3){validatePreviewMenuEdit.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "cut"}}];return false;}}}}}else {validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs14 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validatePreviewMenuEdit.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewMenuEdit.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewMenuEdit.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewScreencastEditRequest}. */
// prettier-ignore
export const validatePreviewScreencastEditRequest: CompiledSchemaCheck<PreviewScreencastEditRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastEditRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewScreencastEditRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.messageId === undefined) && (missing0 = "messageId"))) || ((data.edit === undefined) && (missing0 = "edit"))){validatePreviewScreencastEditRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "messageId")) || (key0 === "edit"))){validatePreviewScreencastEditRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){const _errs3: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageId !== undefined){const _errs4: any = errors;if(!(validatePreviewInputMessageId.call(this, data.messageId, {instancePath:instancePath+"/messageId",parentData:data,parentDataProperty:"messageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewInputMessageId.errors : vErrors.concat(validatePreviewInputMessageId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.edit !== undefined){const _errs5: any = errors;if(!(validatePreviewMenuEdit.call(this, data.edit, {instancePath:instancePath+"/edit",parentData:data,parentDataProperty:"edit",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewMenuEdit.errors : vErrors.concat(validatePreviewMenuEdit.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validatePreviewScreencastEditRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewScreencastEditRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewScreencastEditRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewMenuEditResponse}. */
// prettier-ignore
export const validatePreviewMenuEditResponse: CompiledSchemaCheck<PreviewMenuEditResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewMenuEditResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewMenuEditResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.applied === undefined) && (missing0 = "applied")){validatePreviewMenuEditResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "applied")){validatePreviewMenuEditResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.applied !== undefined){let data0: any = data.applied;if(typeof data0 !== "boolean"){validatePreviewMenuEditResponse.errors = [{instancePath:instancePath+"/applied",schemaPath:"#/properties/applied/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validatePreviewMenuEditResponse.errors = [{instancePath:instancePath+"/applied",schemaPath:"#/properties/applied/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validatePreviewMenuEditResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewMenuEditResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewMenuEditResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewChosenFile}. */
// prettier-ignore
export const validatePreviewChosenFile: CompiledSchemaCheck<PreviewChosenFile> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewChosenFile {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewChosenFile.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.artifactId === undefined) && (missing0 = "artifactId")){validatePreviewChosenFile.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "artifactId") || (key0 === "path"))){validatePreviewChosenFile.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.artifactId !== undefined){const _errs2: any = errors;if(!(validateArtifactId.call(this, data.artifactId, {instancePath:instancePath+"/artifactId",parentData:data,parentDataProperty:"artifactId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 4096){validatePreviewChosenFile.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}}else {validatePreviewChosenFile.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePreviewChosenFile.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewChosenFile.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewChosenFile.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewScreencastFileChooseRequest}. */
// prettier-ignore
export const validatePreviewScreencastFileChooseRequest: CompiledSchemaCheck<PreviewScreencastFileChooseRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastFileChooseRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewScreencastFileChooseRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.messageId === undefined) && (missing0 = "messageId"))) || ((data.files === undefined) && (missing0 = "files"))){validatePreviewScreencastFileChooseRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "messageId")) || (key0 === "files")) || (key0 === "folderName"))){validatePreviewScreencastFileChooseRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){const _errs3: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageId !== undefined){const _errs4: any = errors;if(!(validatePreviewInputMessageId.call(this, data.messageId, {instancePath:instancePath+"/messageId",parentData:data,parentDataProperty:"messageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewInputMessageId.errors : vErrors.concat(validatePreviewInputMessageId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.files !== undefined){let data3: any = data.files;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data3)){var valid1: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs7: any = errors;if(!(validatePreviewChosenFile.call(this, data3[i0], {instancePath:instancePath+"/files/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewChosenFile.errors : vErrors.concat(validatePreviewChosenFile.errors);errors = vErrors.length;}var valid1: any = _errs7 === errors;if(!valid1){break;}}}else {validatePreviewScreencastFileChooseRequest.errors = [{instancePath:instancePath+"/files",schemaPath:"#/properties/files/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.folderName !== undefined){let data5: any = data.folderName;const _errs8: any = errors;if(errors === _errs8){if(typeof data5 === "string"){if(func1(data5) > 4096){validatePreviewScreencastFileChooseRequest.errors = [{instancePath:instancePath+"/folderName",schemaPath:"#/properties/folderName/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data5) < 1){validatePreviewScreencastFileChooseRequest.errors = [{instancePath:instancePath+"/folderName",schemaPath:"#/properties/folderName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validatePreviewScreencastFileChooseRequest.errors = [{instancePath:instancePath+"/folderName",schemaPath:"#/properties/folderName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}}else {validatePreviewScreencastFileChooseRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewScreencastFileChooseRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewScreencastFileChooseRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewScreencastFileChooseResponse}. */
// prettier-ignore
export const validatePreviewScreencastFileChooseResponse: CompiledSchemaCheck<PreviewScreencastFileChooseResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastFileChooseResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewScreencastFileChooseResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.set === undefined) && (missing0 = "set")){validatePreviewScreencastFileChooseResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "set")){validatePreviewScreencastFileChooseResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.set !== undefined){let data0: any = data.set;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validatePreviewScreencastFileChooseResponse.errors = [{instancePath:instancePath+"/set",schemaPath:"#/properties/set/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validatePreviewScreencastFileChooseResponse.errors = [{instancePath:instancePath+"/set",schemaPath:"#/properties/set/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validatePreviewScreencastFileChooseResponse.errors = [{instancePath:instancePath+"/set",schemaPath:"#/properties/set/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validatePreviewScreencastFileChooseResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewScreencastFileChooseResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewScreencastFileChooseResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PreviewScreencastSaveAcknowledgeRequest}. */
// prettier-ignore
export const validatePreviewScreencastSaveAcknowledgeRequest: CompiledSchemaCheck<PreviewScreencastSaveAcknowledgeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PreviewScreencastSaveAcknowledgeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePreviewScreencastSaveAcknowledgeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.pageId === undefined) && (missing0 = "pageId"))) || ((data.saveId === undefined) && (missing0 = "saveId"))){validatePreviewScreencastSaveAcknowledgeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "pageId")) || (key0 === "saveId"))){validatePreviewScreencastSaveAcknowledgeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pageId !== undefined){const _errs3: any = errors;if(!(validatePreviewPageId.call(this, data.pageId, {instancePath:instancePath+"/pageId",parentData:data,parentDataProperty:"pageId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewPageId.errors : vErrors.concat(validatePreviewPageId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.saveId !== undefined){const _errs4: any = errors;if(!(validatePreviewSaveId.call(this, data.saveId, {instancePath:instancePath+"/saveId",parentData:data,parentDataProperty:"saveId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePreviewSaveId.errors : vErrors.concat(validatePreviewSaveId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePreviewScreencastSaveAcknowledgeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePreviewScreencastSaveAcknowledgeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePreviewScreencastSaveAcknowledgeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

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
