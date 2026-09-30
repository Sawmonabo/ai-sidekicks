// The Preview page host's link between the daemon and the desktop's main process,
// over the connection the app dials: main reports each page's debug target and
// relays its debugger traffic, and the daemon reads, writes and clears the page
// host's cookies and site data.
//
// Two method tables follow, one per direction. The daemon answers the link's reports; main
// answers the calls the daemon makes, and those never join the daemon's own method map.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { PreviewAddressSchema, PreviewPageIdSchema, type PreviewPageId } from "./preview.js";
import { FILE_PATH_MAX_LEN } from "./session.js";

/**
 * One debug-protocol message between the daemon's relay and a page's in-process
 * debugger in main: a command, its reply, or an event, each on the page's own
 * session or on a child session named by `sessionId`. Carried as an object, the
 * form both the relay's transport and Electron's debugger read, so neither end
 * encodes it twice.
 */
export type PreviewDebuggerMessage =
  | {
      id: number;
      method: string;
      params?: Record<string, unknown> | undefined;
      sessionId?: string | undefined;
    }
  | { id: number; result: Record<string, unknown>; sessionId?: string | undefined }
  | { id: number; error: { code: number; message: string }; sessionId?: string | undefined }
  | {
      method: string;
      params?: Record<string, unknown> | undefined;
      sessionId?: string | undefined;
    };
const DebuggerParamsSchema = z.record(z.string(), z.unknown());
/** Parses a {@link PreviewDebuggerMessage}. */
export const PreviewDebuggerMessageSchema: z.ZodType<
  PreviewDebuggerMessage,
  PreviewDebuggerMessage
> = z.union([
  z
    .object({
      id: z.number().int(),
      method: z.string().min(1),
      params: DebuggerParamsSchema.optional(),
      sessionId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      id: z.number().int(),
      result: DebuggerParamsSchema,
      sessionId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      id: z.number().int(),
      error: z.object({ code: z.number().int(), message: z.string() }).strict(),
      sessionId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      method: z.string().min(1),
      params: DebuggerParamsSchema.optional(),
      sessionId: z.string().min(1).optional(),
    })
    .strict(),
]);

/** Main reports the debug target behind one page's view, once the view exists. */
export interface PreviewPageTargetReportRequest {
  pageId: PreviewPageId;
  targetId: string;
}
/** Parses a {@link PreviewPageTargetReportRequest}. */
export const PreviewPageTargetReportRequestSchema: z.ZodType<
  PreviewPageTargetReportRequest,
  PreviewPageTargetReportRequest
> = z.object({ pageId: PreviewPageIdSchema, targetId: z.string().min(1) }).strict();

/**
 * One debugger message for one page, in either direction: the daemon sends a
 * command to main, and main returns the replies and events to the daemon.
 */
export interface PreviewPageDebuggerMessageRequest {
  pageId: PreviewPageId;
  message: PreviewDebuggerMessage;
}
/** Parses a {@link PreviewPageDebuggerMessageRequest}. */
export const PreviewPageDebuggerMessageRequestSchema: z.ZodType<
  PreviewPageDebuggerMessageRequest,
  PreviewPageDebuggerMessageRequest
> = z.object({ pageId: PreviewPageIdSchema, message: PreviewDebuggerMessageSchema }).strict();

/** The receiving end took the report or the message. */
export interface PreviewReceivedResponse {
  received: true;
}
/** Parses a {@link PreviewReceivedResponse}. */
export const PreviewReceivedResponseSchema: z.ZodType<PreviewReceivedResponse> = z
  .object({ received: z.literal(true) })
  .strict();

/**
 * One cookie, in the record the daemon's browser library keeps. `expires` is in
 * seconds since the epoch, `-1` for a cookie that lasts the browsing session; main
 * maps it onto its own `expirationDate` both ways. Cookie values are secrets: they
 * travel only between the daemon and main and are never logged.
 */
export interface PreviewCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}
/** Parses a {@link PreviewCookie}. */
export const PreviewCookieSchema: z.ZodType<PreviewCookie, PreviewCookie> = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string().min(1),
    path: z.string().min(1).max(FILE_PATH_MAX_LEN),
    expires: z.number(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(["Strict", "Lax", "None"]),
  })
  .strict();

/** A site's registrable domain, such as `example.com`, the unit site data is cleared by. */
export const PreviewSiteDomainSchema: z.ZodType<string, string> = z.string().min(1).max(253);

/**
 * Read the Preview cookies of one registrable domain, or of every site where
 * `domain` is absent, as a host takes over from the other.
 */
export interface PreviewPageCookiesReadRequest {
  domain?: string | undefined;
}
/** Parses a {@link PreviewPageCookiesReadRequest}. */
export const PreviewPageCookiesReadRequestSchema: z.ZodType<
  PreviewPageCookiesReadRequest,
  PreviewPageCookiesReadRequest
> = z.object({ domain: PreviewSiteDomainSchema.optional() }).strict();

/** Every cookie the read covers. */
export interface PreviewPageCookiesReadResponse {
  cookies: PreviewCookie[];
}
/** Parses a {@link PreviewPageCookiesReadResponse}. */
export const PreviewPageCookiesReadResponseSchema: z.ZodType<PreviewPageCookiesReadResponse> = z
  .object({ cookies: z.array(PreviewCookieSchema) })
  .strict();

/**
 * Write cookies into the Preview site data; a cookie with the same name, domain and path is
 * replaced.
 */
export interface PreviewPageCookiesWriteRequest {
  cookies: PreviewCookie[];
}
/** Parses a {@link PreviewPageCookiesWriteRequest}. */
export const PreviewPageCookiesWriteRequestSchema: z.ZodType<
  PreviewPageCookiesWriteRequest,
  PreviewPageCookiesWriteRequest
> = z.object({ cookies: z.array(PreviewCookieSchema) }).strict();

/** How many of the cookies were written. */
export interface PreviewPageCookiesWriteResponse {
  written: number;
}
/** Parses a {@link PreviewPageCookiesWriteResponse}. */
export const PreviewPageCookiesWriteResponseSchema: z.ZodType<PreviewPageCookiesWriteResponse> = z
  .object({ written: z.number().int().nonnegative() })
  .strict();

/**
 * Clear one site's cookies across its registrable domain, parent-domain cookies
 * included, and nothing else: its storage, cache and service workers stay.
 */
export interface PreviewPageCookiesClearRequest {
  domain: string;
}
/** Parses a {@link PreviewPageCookiesClearRequest}. */
export const PreviewPageCookiesClearRequestSchema: z.ZodType<
  PreviewPageCookiesClearRequest,
  PreviewPageCookiesClearRequest
> = z.object({ domain: PreviewSiteDomainSchema }).strict();

/**
 * Clear every kind of saved data for the named sites, or for every site where
 * `origins` is absent.
 */
export interface PreviewPageSiteDataClearRequest {
  origins?: string[] | undefined;
}
/** Parses a {@link PreviewPageSiteDataClearRequest}; a present list names at least one site. */
export const PreviewPageSiteDataClearRequestSchema: z.ZodType<
  PreviewPageSiteDataClearRequest,
  PreviewPageSiteDataClearRequest
> = z.object({ origins: z.array(PreviewAddressSchema).min(1).optional() }).strict();

/** The clear finished. */
export interface PreviewClearedResponse {
  cleared: true;
}
/** Parses a {@link PreviewClearedResponse}. */
export const PreviewClearedResponseSchema: z.ZodType<PreviewClearedResponse> = z
  .object({ cleared: z.literal(true) })
  .strict();

/** The `preview.*` link methods the daemon answers; main is their only caller. */
export interface PreviewPageLinkMethodDescriptors {
  readonly "preview.pageTargetReport": MethodDescriptor<
    "preview.pageTargetReport",
    PreviewPageTargetReportRequest,
    PreviewReceivedResponse
  >;
  readonly "preview.pageDebuggerReport": MethodDescriptor<
    "preview.pageDebuggerReport",
    PreviewPageDebuggerMessageRequest,
    PreviewReceivedResponse
  >;
}

/** The `preview.*` link methods the daemon answers, each with its schemas. */
export const PREVIEW_PAGE_LINK_METHOD_DESCRIPTORS: PreviewPageLinkMethodDescriptors =
  defineMethodDescriptors({
    "preview.pageTargetReport": {
      method: "preview.pageTargetReport",
      procedureType: "mutation",
      mutating: true,
      requestSchema: PreviewPageTargetReportRequestSchema,
      responseSchema: PreviewReceivedResponseSchema,
    },
    "preview.pageDebuggerReport": {
      method: "preview.pageDebuggerReport",
      procedureType: "mutation",
      mutating: true,
      requestSchema: PreviewPageDebuggerMessageRequestSchema,
      responseSchema: PreviewReceivedResponseSchema,
    },
  });

/**
 * The `preview.*` methods main's page host answers. The daemon is their only caller,
 * over the connection the app dials, so they never join the daemon's own method map.
 */
export interface PreviewPageHostMethodDescriptors {
  readonly "preview.pageDebuggerSend": MethodDescriptor<
    "preview.pageDebuggerSend",
    PreviewPageDebuggerMessageRequest,
    PreviewReceivedResponse
  >;
  readonly "preview.pageCookiesRead": MethodDescriptor<
    "preview.pageCookiesRead",
    PreviewPageCookiesReadRequest,
    PreviewPageCookiesReadResponse
  >;
  readonly "preview.pageCookiesWrite": MethodDescriptor<
    "preview.pageCookiesWrite",
    PreviewPageCookiesWriteRequest,
    PreviewPageCookiesWriteResponse
  >;
  readonly "preview.pageCookiesClear": MethodDescriptor<
    "preview.pageCookiesClear",
    PreviewPageCookiesClearRequest,
    PreviewClearedResponse
  >;
  readonly "preview.pageSiteDataClear": MethodDescriptor<
    "preview.pageSiteDataClear",
    PreviewPageSiteDataClearRequest,
    PreviewClearedResponse
  >;
}

/** The `preview.*` methods main's page host answers, each with its schemas. */
export const PREVIEW_PAGE_HOST_METHOD_DESCRIPTORS: PreviewPageHostMethodDescriptors =
  defineMethodDescriptors({
    "preview.pageDebuggerSend": {
      method: "preview.pageDebuggerSend",
      procedureType: "mutation",
      mutating: true,
      requestSchema: PreviewPageDebuggerMessageRequestSchema,
      responseSchema: PreviewReceivedResponseSchema,
    },
    "preview.pageCookiesRead": {
      method: "preview.pageCookiesRead",
      procedureType: "query",
      mutating: false,
      requestSchema: PreviewPageCookiesReadRequestSchema,
      responseSchema: PreviewPageCookiesReadResponseSchema,
    },
    "preview.pageCookiesWrite": {
      method: "preview.pageCookiesWrite",
      procedureType: "mutation",
      mutating: true,
      requestSchema: PreviewPageCookiesWriteRequestSchema,
      responseSchema: PreviewPageCookiesWriteResponseSchema,
    },
    "preview.pageCookiesClear": {
      method: "preview.pageCookiesClear",
      procedureType: "mutation",
      mutating: true,
      requestSchema: PreviewPageCookiesClearRequestSchema,
      responseSchema: PreviewClearedResponseSchema,
    },
    "preview.pageSiteDataClear": {
      method: "preview.pageSiteDataClear",
      procedureType: "mutation",
      mutating: true,
      requestSchema: PreviewPageSiteDataClearRequestSchema,
      responseSchema: PreviewClearedResponseSchema,
    },
  });
