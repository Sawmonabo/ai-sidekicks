// The Preview pane's wire: the pages a session owns and the verbs a client moves
// them with, the dev servers the daemon discovers, the marks sent to the provider,
// and the live picture for another device. The page host's link to the desktop's
// main process is `preview-page-host.ts`; the ports shared with the person's other
// devices are `preview-port.ts`.
//
// The daemon owns every page and mints every page id; the renderer owns none. It
// reads the list, sends requests keyed by session and page, and main keeps one
// native view per page in step with the list.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import { MAX_MESSAGE_BYTES } from "./jsonrpc.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { PreviewPortSchema } from "./preview-port.js";
import { SessionIdSchema, type SessionId } from "./session.js";
import { WEB_ADDRESS_FAULTS, type WebAddressFault } from "./web-address.js";

// ---------------------------------------------------------------------------
// Ids, addresses and zoom
// ---------------------------------------------------------------------------

/** The longest page id the daemon mints. */
export const PREVIEW_PAGE_ID_MAX_LEN = 256;
/** The daemon's own handle for one page. Opaque to every client. */
export type PreviewPageId = string & { readonly __brand: "PreviewPageId" };
/** Parses a {@link PreviewPageId}: a non-empty string up to {@link PREVIEW_PAGE_ID_MAX_LEN}. */
export const PreviewPageIdSchema: z.ZodType<PreviewPageId, PreviewPageId> = z
  .string()
  .min(1)
  .max(PREVIEW_PAGE_ID_MAX_LEN)
  .brand<"PreviewPageId">() as unknown as z.ZodType<PreviewPageId, PreviewPageId>;

/** The longest address Preview takes: Chromium's own limit on a URL's length. */
export const PREVIEW_ADDRESS_MAX_LEN: number = 2 * 1024 * 1024;
/** Parses an address as it crosses the wire; what it may name is judged where it lands. */
export const PreviewAddressSchema: z.ZodType<string, string> = z
  .string()
  .min(1)
  .max(PREVIEW_ADDRESS_MAX_LEN);

/**
 * The zoom factors a page steps through, Chromium's own presets from 50 % to 200 %.
 * 67 % is Chromium's 2/3 exactly, so both ends compare the same number.
 */
export const PREVIEW_ZOOM_FACTORS: readonly number[] = Object.freeze([
  0.5,
  2 / 3,
  0.75,
  0.8,
  0.9,
  1,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
]);
/** Parses a zoom factor: one of {@link PREVIEW_ZOOM_FACTORS} and nothing between them. */
export const PreviewZoomFactorSchema: z.ZodType<number, number> = z
  .number()
  .refine((factor) => PREVIEW_ZOOM_FACTORS.includes(factor), {
    message: "zoomFactor must be one of the preset zoom factors",
  });

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * An address Preview will not open, refused with its cause and the page left
 * where it was. Nothing is ever searched on the web.
 */
export type PreviewAddressRefusedCode = "preview.address_refused";
export const PREVIEW_ADDRESS_REFUSED_CODE: PreviewAddressRefusedCode = "preview.address_refused";
/**
 * Why an address was refused: it carries a username or a password, its scheme is
 * one the pane cannot open, or the text is not an address at all.
 */
export type PreviewAddressRefusedReason = WebAddressFault | "not_an_address";
export const PREVIEW_ADDRESS_REFUSED_REASONS: readonly PreviewAddressRefusedReason[] =
  Object.freeze([...WEB_ADDRESS_FAULTS, "not_an_address"]);
/** The details a `preview.address_refused` refusal carries. It never echoes the address. */
export interface PreviewAddressRefusedDetails {
  reason: PreviewAddressRefusedReason;
}
/** Parses {@link PreviewAddressRefusedDetails}. */
export const PreviewAddressRefusedDetailsSchema: z.ZodType<PreviewAddressRefusedDetails> = z
  .object({ reason: z.enum(PREVIEW_ADDRESS_REFUSED_REASONS as [PreviewAddressRefusedReason]) })
  .strict();

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * A page's own icon, as the image's bytes rather than its address. The console
 * draws only images it holds (its content policy admits `data:` and nothing
 * remote), another device cannot reach an icon a loopback page serves, and a
 * released page keeps its icon in the strip while nothing is loaded. The encoded
 * icon is held to one message frame, the most any single member can carry.
 */
export interface PreviewFavicon {
  mediaType: string;
  data: string;
}
const PreviewFaviconSchema: z.ZodType<PreviewFavicon, PreviewFavicon> = z
  .object({
    mediaType: z.string().regex(/^image\/[a-z0-9.+-]+$/u, "mediaType must be an image type"),
    data: z.base64().min(1).max(MAX_MESSAGE_BYTES),
  })
  .strict();

/**
 * Where a page's load stands: loading, with the fraction the engine reports or
 * `null` when it reports none (the surface then draws an indeterminate mark); loaded;
 * or failed, which the pane reads as `<host> did not answer.` with a try-again.
 */
export type PreviewPageLoadState =
  | { kind: "loading"; progress: number | null }
  | { kind: "loaded" }
  | { kind: "failed" };
const PreviewPageLoadStateSchema: z.ZodType<PreviewPageLoadState, PreviewPageLoadState> =
  z.discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("loading"), progress: z.number().min(0).max(1).nullable() })
      .strict(),
    z.object({ kind: z.literal("loaded") }).strict(),
    z.object({ kind: z.literal("failed") }).strict(),
  ]);

/**
 * One open page in a session's Preview pane.
 *
 * `title` is the page's own title and may be empty; a surface that labels the page
 * shows `host` in its place, so the host is carried rather than re-parsed from the
 * address at every call site. `favicon` is `null` where the page has none.
 *
 * `backDepth` and `forwardDepth` are how far the page's history reaches either way:
 * the back and forward controls act when theirs is above zero.
 *
 * `zoomFactor` is the page's own, applied on the machine that runs it. `released` is
 * a page whose view was destroyed to free memory, or one brought back after a restart:
 * its address, order and zoom are kept, main destroys its view, and it reloads when
 * shown.
 */
export interface PreviewPage {
  pageId: PreviewPageId;
  address: string;
  host: string;
  title: string;
  favicon: PreviewFavicon | null;
  loadState: PreviewPageLoadState;
  backDepth: number;
  forwardDepth: number;
  zoomFactor: number;
  released: boolean;
}
/** Parses a {@link PreviewPage}. */
export const PreviewPageSchema: z.ZodType<PreviewPage> = z
  .object({
    pageId: PreviewPageIdSchema,
    address: PreviewAddressSchema,
    host: z.string(),
    title: z.string(),
    favicon: PreviewFaviconSchema.nullable(),
    loadState: PreviewPageLoadStateSchema,
    backDepth: z.number().int().nonnegative(),
    forwardDepth: z.number().int().nonnegative(),
    zoomFactor: PreviewZoomFactorSchema,
    released: z.boolean(),
  })
  .strict();

/** The session whose pages a `preview.pageList` subscription streams. */
export interface PreviewPageListRequest {
  sessionId: SessionId;
}
/** Parses a {@link PreviewPageListRequest}. */
export const PreviewPageListRequestSchema: z.ZodType<
  PreviewPageListRequest,
  PreviewPageListRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/**
 * One frame of a session's page list: every page in the session's order, and the
 * index of the one the pane shows, `-1` where the session has no page open. The
 * first frame is the list as it stands; a new frame follows every change.
 */
export interface PreviewPageListFrame {
  pages: PreviewPage[];
  activeIndex: number;
}
/** Parses a {@link PreviewPageListFrame}; the active index names a page in the list or none. */
export const PreviewPageListFrameSchema: z.ZodType<PreviewPageListFrame> = z
  .object({
    pages: z.array(PreviewPageSchema),
    activeIndex: z.number().int().min(-1),
  })
  .strict()
  .refine((frame) => frame.activeIndex < frame.pages.length, {
    message: "activeIndex must name a page in the list, or be -1",
    path: ["activeIndex"],
  });

/**
 * What a page opens on: an address the person or an agent gave, or a dev server the
 * daemon discovered. A closed union, so a caller cannot ask for both and leave the
 * daemon to choose. A popup a page opens reaches the list the same way, as an
 * address main hands over.
 */
export type PreviewPageTarget =
  | { kind: "address"; address: string }
  | { kind: "devServer"; port: number };
/** Parses a {@link PreviewPageTarget}. */
export const PreviewPageTargetSchema: z.ZodType<PreviewPageTarget, PreviewPageTarget> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("address"), address: PreviewAddressSchema }).strict(),
    z.object({ kind: z.literal("devServer"), port: PreviewPortSchema }).strict(),
  ]);

/** Open one page in a session. A retried open makes a second page. */
export interface PreviewPageOpenRequest {
  sessionId: SessionId;
  target: PreviewPageTarget;
}
/** Parses a {@link PreviewPageOpenRequest}. */
export const PreviewPageOpenRequestSchema: z.ZodType<
  PreviewPageOpenRequest,
  PreviewPageOpenRequest
> = z.object({ sessionId: SessionIdSchema, target: PreviewPageTargetSchema }).strict();

/**
 * The page opened, and the address it loads.
 *
 * `movedFrom` is the dev server's own port where the page loads on another one
 * because that number was taken on the side the page runs, so the address line can
 * read `127.0.0.1:5174 (5173 was in use)`. It is required and `null` where the port
 * did not move.
 */
export interface PreviewPageOpenResponse {
  pageId: PreviewPageId;
  address: string;
  movedFrom: number | null;
}
/** Parses a {@link PreviewPageOpenResponse}. */
export const PreviewPageOpenResponseSchema: z.ZodType<PreviewPageOpenResponse> = z
  .object({
    pageId: PreviewPageIdSchema,
    address: PreviewAddressSchema,
    movedFrom: PreviewPortSchema.nullable(),
  })
  .strict();

/** Names one page of one session: close it, or make it the one the pane shows. */
export interface PreviewPageRequest {
  sessionId: SessionId;
  pageId: PreviewPageId;
}
/** Parses a {@link PreviewPageRequest}. */
export const PreviewPageRequestSchema: z.ZodType<PreviewPageRequest, PreviewPageRequest> = z
  .object({ sessionId: SessionIdSchema, pageId: PreviewPageIdSchema })
  .strict();

/** A page closed. Closing a page that is already gone answers the same. */
export interface PreviewPageCloseResponse {
  closed: true;
}
/** Parses a {@link PreviewPageCloseResponse}. */
export const PreviewPageCloseResponseSchema: z.ZodType<PreviewPageCloseResponse> = z
  .object({ closed: z.literal(true) })
  .strict();

/** The page the pane now shows. Activating the active page answers the same. */
export interface PreviewPageActivateResponse {
  activePageId: PreviewPageId;
}
/** Parses a {@link PreviewPageActivateResponse}. */
export const PreviewPageActivateResponseSchema: z.ZodType<PreviewPageActivateResponse> = z
  .object({ activePageId: PreviewPageIdSchema })
  .strict();

/**
 * Move one page within its session's order.
 *
 * `toIndex` is a position in the list WITHOUT that page in it. The surface that
 * drags a tab counts drop slots among the tabs as drawn and translates once, where
 * it sends the request.
 */
export interface PreviewPageReorderRequest {
  sessionId: SessionId;
  pageId: PreviewPageId;
  toIndex: number;
}
/** Parses a {@link PreviewPageReorderRequest}. */
export const PreviewPageReorderRequestSchema: z.ZodType<
  PreviewPageReorderRequest,
  PreviewPageReorderRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    pageId: PreviewPageIdSchema,
    toIndex: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The session's page order after the move. The order is the session's, so every
 * device draws the same strip; moving a page to where it already is answers the
 * order unchanged.
 */
export interface PreviewPageReorderResponse {
  pageIds: PreviewPageId[];
}
/** Parses a {@link PreviewPageReorderResponse}. */
export const PreviewPageReorderResponseSchema: z.ZodType<PreviewPageReorderResponse> = z
  .object({ pageIds: z.array(PreviewPageIdSchema) })
  .strict();

/**
 * Where a navigation takes a page. Back, forward and reload ride the same verb as
 * an address, because all four move the same page within its own history.
 */
export type PreviewNavigationTarget =
  | { kind: "address"; address: string }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" };
/** Parses a {@link PreviewNavigationTarget}. */
export const PreviewNavigationTargetSchema: z.ZodType<
  PreviewNavigationTarget,
  PreviewNavigationTarget
> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("address"), address: PreviewAddressSchema }).strict(),
  z.object({ kind: z.literal("back") }).strict(),
  z.object({ kind: z.literal("forward") }).strict(),
  z.object({ kind: z.literal("reload") }).strict(),
]);

/** Navigate one page. */
export interface PreviewNavigateRequest {
  sessionId: SessionId;
  pageId: PreviewPageId;
  to: PreviewNavigationTarget;
}
/** Parses a {@link PreviewNavigateRequest}. */
export const PreviewNavigateRequestSchema: z.ZodType<
  PreviewNavigateRequest,
  PreviewNavigateRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    pageId: PreviewPageIdSchema,
    to: PreviewNavigationTargetSchema,
  })
  .strict();

/**
 * Where the page stands after the navigation: the address it loads, with
 * `movedFrom` as on {@link PreviewPageOpenResponse}, and its history depths.
 */
export interface PreviewNavigateResponse {
  pageId: PreviewPageId;
  address: string;
  movedFrom: number | null;
  backDepth: number;
  forwardDepth: number;
}
/** Parses a {@link PreviewNavigateResponse}. */
export const PreviewNavigateResponseSchema: z.ZodType<PreviewNavigateResponse> = z
  .object({
    pageId: PreviewPageIdSchema,
    address: PreviewAddressSchema,
    movedFrom: PreviewPortSchema.nullable(),
    backDepth: z.number().int().nonnegative(),
    forwardDepth: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Set one page's zoom on the machine that runs it, so the live picture carries the
 * result. A new page starts at 1; each open page keeps its own factor.
 */
export interface PreviewZoomRequest {
  sessionId: SessionId;
  pageId: PreviewPageId;
  zoomFactor: number;
}
/** Parses a {@link PreviewZoomRequest}. */
export const PreviewZoomRequestSchema: z.ZodType<PreviewZoomRequest, PreviewZoomRequest> = z
  .object({
    sessionId: SessionIdSchema,
    pageId: PreviewPageIdSchema,
    zoomFactor: PreviewZoomFactorSchema,
  })
  .strict();

/** The factor the page now has. */
export interface PreviewZoomResponse {
  pageId: PreviewPageId;
  zoomFactor: number;
}
/** Parses a {@link PreviewZoomResponse}. */
export const PreviewZoomResponseSchema: z.ZodType<PreviewZoomResponse> = z
  .object({ pageId: PreviewPageIdSchema, zoomFactor: PreviewZoomFactorSchema })
  .strict();

// ---------------------------------------------------------------------------
// Dev servers
// ---------------------------------------------------------------------------

/** The session whose project's dev servers a `preview.devServerList` subscription streams. */
export interface PreviewDevServerListRequest {
  sessionId: SessionId;
}
/** Parses a {@link PreviewDevServerListRequest}. */
export const PreviewDevServerListRequestSchema: z.ZodType<
  PreviewDevServerListRequest,
  PreviewDevServerListRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/**
 * One dev server the daemon found listening in the session's project.
 *
 * `name` and `framework` are `null` where the daemon could not tell, so the row
 * reads the port alone. `startedHere` is true where this session started the
 * server, by its agent or in its own shell.
 */
export interface PreviewDevServer {
  port: number;
  name: string | null;
  framework: string | null;
  startedHere: boolean;
}
/** Parses a {@link PreviewDevServer}. */
export const PreviewDevServerSchema: z.ZodType<PreviewDevServer> = z
  .object({
    port: PreviewPortSchema,
    name: z.string().min(1).nullable(),
    framework: z.string().min(1).nullable(),
    startedHere: z.boolean(),
  })
  .strict();

/** One frame of the discovered servers: every server listening now. */
export const PreviewDevServerListFrameSchema: z.ZodType<PreviewDevServer[]> =
  z.array(PreviewDevServerSchema);

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

/** A point on the page, in viewport CSS pixels. */
export interface PreviewPoint {
  x: number;
  y: number;
}
const PreviewPointSchema: z.ZodType<PreviewPoint, PreviewPoint> = z
  .object({ x: z.number(), y: z.number() })
  .strict();

/** A rectangle on the page, in viewport CSS pixels. */
export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
const PreviewRectSchema: z.ZodType<PreviewRect, PreviewRect> = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

/**
 * The element a mark landed on, as the page snapshot taken when the mark was made
 * names it: the snapshot's element reference and that element's box. A reference
 * holds only for the snapshot that minted it, so its generation rides with it.
 */
export interface PreviewMarkElement {
  ref: string;
  box: PreviewRect;
  snapshotGeneration: number;
}
const PreviewMarkElementSchema: z.ZodType<PreviewMarkElement, PreviewMarkElement> = z
  .object({
    ref: z.string().min(1),
    box: PreviewRectSchema,
    snapshotGeneration: z.number().int().nonnegative(),
  })
  .strict();

/** The longest note a comment or a box carries. */
export const PREVIEW_MARK_NOTE_MAX_LEN = 4096;

/**
 * One mark on the frozen picture. A comment is a numbered pin at a point, a box a
 * numbered rectangle, and a stroke a freehand line in the color it was drawn with.
 * Strokes are never numbered, which is why removing a comment renumbers the
 * comments and boxes and leaves strokes alone. `note` is `null` where the person
 * wrote none; `element` is `null` where the mark hit no element.
 */
export type PreviewMark =
  | {
      kind: "comment";
      number: number;
      note: string | null;
      point: PreviewPoint;
      element: PreviewMarkElement | null;
    }
  | {
      kind: "box";
      number: number;
      note: string | null;
      rect: PreviewRect;
      element: PreviewMarkElement | null;
    }
  | {
      kind: "stroke";
      points: PreviewPoint[];
      color: string;
      element: PreviewMarkElement | null;
    };
const PreviewMarkNoteSchema = z.string().min(1).max(PREVIEW_MARK_NOTE_MAX_LEN).nullable();
/** Parses a {@link PreviewMark}. A stroke's color is an sRGB hex color, `#rrggbb`. */
export const PreviewMarkSchema: z.ZodType<PreviewMark, PreviewMark> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("comment"),
      number: z.number().int().positive(),
      note: PreviewMarkNoteSchema,
      point: PreviewPointSchema,
      element: PreviewMarkElementSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("box"),
      number: z.number().int().positive(),
      note: PreviewMarkNoteSchema,
      rect: PreviewRectSchema,
      element: PreviewMarkElementSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stroke"),
      points: z.array(PreviewPointSchema).min(1),
      color: z.string().regex(/^#[0-9a-f]{6}$/iu),
      element: PreviewMarkElementSchema.nullable(),
    })
    .strict(),
]);

/** The frozen picture the marks were drawn on, at the pixel size it was captured. */
export interface PreviewMarksPicture {
  mediaType: "image/png" | "image/jpeg";
  data: string;
  width: number;
  height: number;
}
const PreviewMarksPictureSchema: z.ZodType<PreviewMarksPicture, PreviewMarksPicture> = z
  .object({
    mediaType: z.enum(["image/png", "image/jpeg"]),
    data: z.base64().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

/**
 * Send the marks on one page to the session's provider as one attachment: the
 * picture, the marks that exist now, the page's address and its width in CSS
 * pixels. An attachment whose last mark was removed is not sent, so `marks` is
 * never empty.
 */
export interface PreviewMarksSendRequest {
  sessionId: SessionId;
  pageId: PreviewPageId;
  picture: PreviewMarksPicture;
  marks: PreviewMark[];
  address: string;
  pageWidth: number;
}
/** Parses a {@link PreviewMarksSendRequest}. */
export const PreviewMarksSendRequestSchema: z.ZodType<
  PreviewMarksSendRequest,
  PreviewMarksSendRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    pageId: PreviewPageIdSchema,
    picture: PreviewMarksPictureSchema,
    marks: z.array(PreviewMarkSchema).min(1),
    address: PreviewAddressSchema,
    pageWidth: z.number().int().positive(),
  })
  .strict();

/**
 * The attachment reached the provider, in that provider's own image shape, which
 * differs per provider, so nothing about the encoding reaches a client.
 */
export interface PreviewMarksSendResponse {
  delivered: true;
}
/** Parses a {@link PreviewMarksSendResponse}. */
export const PreviewMarksSendResponseSchema: z.ZodType<PreviewMarksSendResponse> = z
  .object({ delivered: z.literal(true) })
  .strict();

// ---------------------------------------------------------------------------
// The live picture for another device
// ---------------------------------------------------------------------------

/** The page whose live picture another device watches while it has the pane open. */
export interface PreviewScreencastSubscribeRequest {
  sessionId: SessionId;
  pageId: PreviewPageId;
}
/** Parses a {@link PreviewScreencastSubscribeRequest}. */
export const PreviewScreencastSubscribeRequestSchema: z.ZodType<
  PreviewScreencastSubscribeRequest,
  PreviewScreencastSubscribeRequest
> = z.object({ sessionId: SessionIdSchema, pageId: PreviewPageIdSchema }).strict();

/**
 * One frame of the live picture: a JPEG, what maps its pixels back to page
 * coordinates (so a mark drawn on the picture lands on the same element as one
 * drawn on the page), and the token the watcher returns to acknowledge it. An
 * unacknowledged stream stalls after a few frames in flight.
 */
export interface PreviewScreencastFrame {
  pageId: PreviewPageId;
  imageData: string;
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
  };
  ackToken: string;
}
/** Parses a {@link PreviewScreencastFrame}. */
export const PreviewScreencastFrameSchema: z.ZodType<PreviewScreencastFrame> = z
  .object({
    pageId: PreviewPageIdSchema,
    imageData: z.base64().min(1),
    metadata: z
      .object({
        offsetTop: z.number(),
        pageScaleFactor: z.number().positive(),
        deviceWidth: z.number().nonnegative(),
        deviceHeight: z.number().nonnegative(),
        scrollOffsetX: z.number(),
        scrollOffsetY: z.number(),
      })
      .strict(),
    ackToken: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

/**
 * The `preview.*` page, dev-server, marks and live-picture methods the daemon
 * answers. Its other `preview.*` methods are the page host's link reports
 * (`PREVIEW_PAGE_LINK_METHOD_DESCRIPTORS`) and the shared ports
 * (`PREVIEW_PORT_METHOD_DESCRIPTORS`).
 */
export interface PreviewMethodDescriptors {
  readonly "preview.pageList": SubscriptionMethodDescriptor<
    "preview.pageList",
    PreviewPageListRequest,
    SubscribeAckResponse,
    PreviewPageListFrame
  >;
  readonly "preview.pageOpen": MethodDescriptor<
    "preview.pageOpen",
    PreviewPageOpenRequest,
    PreviewPageOpenResponse
  >;
  readonly "preview.pageClose": MethodDescriptor<
    "preview.pageClose",
    PreviewPageRequest,
    PreviewPageCloseResponse
  >;
  readonly "preview.pageActivate": MethodDescriptor<
    "preview.pageActivate",
    PreviewPageRequest,
    PreviewPageActivateResponse
  >;
  readonly "preview.pageReorder": MethodDescriptor<
    "preview.pageReorder",
    PreviewPageReorderRequest,
    PreviewPageReorderResponse
  >;
  readonly "preview.navigate": MethodDescriptor<
    "preview.navigate",
    PreviewNavigateRequest,
    PreviewNavigateResponse
  >;
  readonly "preview.zoom": MethodDescriptor<
    "preview.zoom",
    PreviewZoomRequest,
    PreviewZoomResponse
  >;
  readonly "preview.devServerList": SubscriptionMethodDescriptor<
    "preview.devServerList",
    PreviewDevServerListRequest,
    SubscribeAckResponse,
    PreviewDevServer[]
  >;
  readonly "preview.marksSend": MethodDescriptor<
    "preview.marksSend",
    PreviewMarksSendRequest,
    PreviewMarksSendResponse
  >;
  readonly "preview.screencastSubscribe": SubscriptionMethodDescriptor<
    "preview.screencastSubscribe",
    PreviewScreencastSubscribeRequest,
    SubscribeAckResponse,
    PreviewScreencastFrame
  >;
}

/** The `preview.*` page methods the daemon answers, each with its schemas. */
export const PREVIEW_METHOD_DESCRIPTORS: PreviewMethodDescriptors = defineMethodDescriptors({
  "preview.pageList": {
    method: "preview.pageList",
    procedureType: "subscription",
    mutating: false,
    requestSchema: PreviewPageListRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: PreviewPageListFrameSchema,
  },
  "preview.pageOpen": {
    method: "preview.pageOpen",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PreviewPageOpenRequestSchema,
    responseSchema: PreviewPageOpenResponseSchema,
  },
  "preview.pageClose": {
    method: "preview.pageClose",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PreviewPageRequestSchema,
    responseSchema: PreviewPageCloseResponseSchema,
  },
  "preview.pageActivate": {
    method: "preview.pageActivate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PreviewPageRequestSchema,
    responseSchema: PreviewPageActivateResponseSchema,
  },
  "preview.pageReorder": {
    method: "preview.pageReorder",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PreviewPageReorderRequestSchema,
    responseSchema: PreviewPageReorderResponseSchema,
  },
  "preview.navigate": {
    method: "preview.navigate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PreviewNavigateRequestSchema,
    responseSchema: PreviewNavigateResponseSchema,
  },
  "preview.zoom": {
    method: "preview.zoom",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PreviewZoomRequestSchema,
    responseSchema: PreviewZoomResponseSchema,
  },
  "preview.devServerList": {
    method: "preview.devServerList",
    procedureType: "subscription",
    mutating: false,
    requestSchema: PreviewDevServerListRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: PreviewDevServerListFrameSchema,
  },
  "preview.marksSend": {
    method: "preview.marksSend",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PreviewMarksSendRequestSchema,
    responseSchema: PreviewMarksSendResponseSchema,
  },
  "preview.screencastSubscribe": {
    method: "preview.screencastSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: PreviewScreencastSubscribeRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: PreviewScreencastFrameSchema,
  },
});

// ---------------------------------------------------------------------------
// The keystroke main hands back from a page
// ---------------------------------------------------------------------------

/**
 * One keystroke main claimed from a page and handed back to the console to replay.
 *
 * It carries the `KeyboardEvent` members a chord is matched on and nothing that
 * names an action: the console publishes which chords exist, never what they do,
 * and replays the keystroke through its own bindings. `isComposing` is carried
 * because a keystroke inside an input-method composition is never claimed, and only
 * the event itself knows that it was one.
 */
export interface BrowserPageChord {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}
