// The machine-wide browser methods behind Settings › Browser. Site data is one set per
// machine, shared by every Preview page, the agent's browser tools and a workflow's browser
// steps. Every per-site act takes one origin and applies to its whole registrable domain, so
// a login cookie set on the parent domain goes with it.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { webAddressFault } from "./web-address.js";
import { countSchema, isoDateTimeSchema } from "./internal/wire-scalars.js";

/**
 * Parses a site's origin, `scheme://host` with a port only where it is not the
 * scheme's own: an `http:` or `https:` origin with no credentials, no path, no query
 * and no fragment.
 */
export const BrowserSiteOriginSchema: z.ZodType<string, string> = z
  .string()
  .min(1)
  .refine(
    (origin) => {
      if (!URL.canParse(origin)) {
        return false;
      }
      const address = new URL(origin);
      return webAddressFault(address) === null && address.origin === origin;
    },
    { message: "origin must be an http(s) origin, scheme://host[:port]" },
  );

/** Settings › Browser's list read, and its clear-all: machine-wide, so they name nothing. */
export type BrowserMachineRequest = Record<string, never>;
/** Parses a {@link BrowserMachineRequest}. */
export const BrowserMachineRequestSchema: z.ZodType<BrowserMachineRequest, BrowserMachineRequest> =
  z.object({}).strict();

/**
 * One site holding saved data. `hasCookies` is true while it holds at least one
 * unexpired cookie, and the row then reads `Saved cookies`; otherwise it holds other
 * saved data and reads `Saved site data`. Nothing here says whether the person is
 * signed in, because a cookie does not prove a login.
 */
export interface BrowserSiteData {
  origin: string;
  sizeBytes: number;
  lastUsedAt: string;
  hasCookies: boolean;
}
/** Parses a {@link BrowserSiteData}. */
export const BrowserSiteDataSchema: z.ZodType<BrowserSiteData> = z
  .object({
    origin: BrowserSiteOriginSchema,
    sizeBytes: countSchema,
    lastUsedAt: isoDateTimeSchema,
    hasCookies: z.boolean(),
  })
  .strict();

/** Every site with saved data, one per registrable domain. */
export interface BrowserSiteDataListResponse {
  sites: BrowserSiteData[];
}
/** Parses a {@link BrowserSiteDataListResponse}. */
export const BrowserSiteDataListResponseSchema: z.ZodType<BrowserSiteDataListResponse> = z
  .object({ sites: z.array(BrowserSiteDataSchema) })
  .strict();

/** Names one site: sign in to it, clear its cookies, or forget it. */
export interface BrowserSiteRequest {
  origin: string;
}
/** Parses a {@link BrowserSiteRequest}. */
export const BrowserSiteRequestSchema: z.ZodType<BrowserSiteRequest, BrowserSiteRequest> = z
  .object({ origin: BrowserSiteOriginSchema })
  .strict();

/**
 * The site opened in a page of its own that belongs to no session, over the machine's site data,
 * showing the address line and nothing else. What the site saves there is kept for every browser.
 */
export interface BrowserSiteSignInResponse {
  opened: true;
}
/** Parses a {@link BrowserSiteSignInResponse}. */
export const BrowserSiteSignInResponseSchema: z.ZodType<BrowserSiteSignInResponse> = z
  .object({ opened: z.literal(true) })
  .strict();

/**
 * The site's cookies are gone across its registrable domain, and nothing else: its
 * storage, cache and service workers stay. It claims nothing about signing out.
 */
export interface BrowserSiteCookiesClearResponse {
  origin: string;
  cleared: true;
}
/** Parses a {@link BrowserSiteCookiesClearResponse}. */
export const BrowserSiteCookiesClearResponseSchema: z.ZodType<BrowserSiteCookiesClearResponse> = z
  .object({ origin: BrowserSiteOriginSchema, cleared: z.literal(true) })
  .strict();

/** Every kind of data the site saved is gone. A site holding nothing answers the same. */
export interface BrowserSiteDataForgetResponse {
  origin: string;
  forgotten: true;
}
/** Parses a {@link BrowserSiteDataForgetResponse}. */
export const BrowserSiteDataForgetResponseSchema: z.ZodType<BrowserSiteDataForgetResponse> = z
  .object({ origin: BrowserSiteOriginSchema, forgotten: z.literal(true) })
  .strict();

/** Every site's saved data is gone. */
export interface BrowserSiteDataClearResponse {
  cleared: true;
}
/** Parses a {@link BrowserSiteDataClearResponse}. */
export const BrowserSiteDataClearResponseSchema: z.ZodType<BrowserSiteDataClearResponse> = z
  .object({ cleared: z.literal(true) })
  .strict();

/**
 * Which Chromium runs pages: the desktop app's own, an installed Chrome or Edge,
 * or the one the browser library fetched on first need.
 */
export type BrowserChromiumSource = "desktop" | "chrome" | "edge" | "playwright";
/** Every {@link BrowserChromiumSource}. */
export const BROWSER_CHROMIUM_SOURCES: readonly BrowserChromiumSource[] = Object.freeze([
  "desktop",
  "chrome",
  "edge",
  "playwright",
]);

/** Why the daemon's headless Chromium cannot start on this machine. */
export type BrowserChromiumCannotStartReason = "missingSystemLibraries";
/** Every {@link BrowserChromiumCannotStartReason}. */
export const BROWSER_CHROMIUM_CANNOT_START_REASONS: readonly BrowserChromiumCannotStartReason[] =
  Object.freeze(["missingSystemLibraries"]);

/**
 * The headless Chromium cannot start. `installStep` is the browser library's own
 * command for the version the service carries, shown as text and never run,
 * because it needs an administrator.
 */
export interface BrowserChromiumCannotStart {
  reason: BrowserChromiumCannotStartReason;
  installStep: string;
}

/**
 * The Chromium in use, its version, and when it was fetched. `fetchedAt` is set
 * exactly when the source is the fetched one. `cannotStart` is `null` unless the
 * headless Chromium cannot start here.
 */
export interface BrowserChromiumReadResponse {
  source: BrowserChromiumSource;
  version: string;
  fetchedAt: string | null;
  cannotStart: BrowserChromiumCannotStart | null;
}
/** Parses a {@link BrowserChromiumReadResponse}. */
export const BrowserChromiumReadResponseSchema: z.ZodType<BrowserChromiumReadResponse> = z
  .object({
    source: z.enum(BROWSER_CHROMIUM_SOURCES),
    version: z.string().min(1),
    fetchedAt: isoDateTimeSchema.nullable(),
    cannotStart: z
      .object({
        reason: z.enum(BROWSER_CHROMIUM_CANNOT_START_REASONS),
        installStep: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((reading) => (reading.fetchedAt !== null) === (reading.source === "playwright"), {
    message: "fetchedAt is set exactly when the source is the fetched Chromium",
    path: ["fetchedAt"],
  });

/** The fetch started; its progress is a flow row. A fetch asked for during one joins it. */
export interface BrowserChromiumFetchResponse {
  started: true;
}
/** Parses a {@link BrowserChromiumFetchResponse}. */
export const BrowserChromiumFetchResponseSchema: z.ZodType<BrowserChromiumFetchResponse> = z
  .object({ started: z.literal(true) })
  .strict();

/** The `browser.*` methods the daemon answers. */
export interface BrowserMethodDescriptors {
  readonly "browser.siteDataList": MethodDescriptor<
    "browser.siteDataList",
    BrowserMachineRequest,
    BrowserSiteDataListResponse
  >;
  readonly "browser.siteSignIn": MethodDescriptor<
    "browser.siteSignIn",
    BrowserSiteRequest,
    BrowserSiteSignInResponse
  >;
  readonly "browser.siteCookiesClear": MethodDescriptor<
    "browser.siteCookiesClear",
    BrowserSiteRequest,
    BrowserSiteCookiesClearResponse
  >;
  readonly "browser.siteDataForget": MethodDescriptor<
    "browser.siteDataForget",
    BrowserSiteRequest,
    BrowserSiteDataForgetResponse
  >;
  readonly "browser.siteDataClear": MethodDescriptor<
    "browser.siteDataClear",
    BrowserMachineRequest,
    BrowserSiteDataClearResponse
  >;
  readonly "browser.chromiumRead": MethodDescriptor<
    "browser.chromiumRead",
    BrowserMachineRequest,
    BrowserChromiumReadResponse
  >;
  readonly "browser.chromiumFetch": MethodDescriptor<
    "browser.chromiumFetch",
    BrowserMachineRequest,
    BrowserChromiumFetchResponse
  >;
}

/**
 * The `browser.*` methods the daemon answers, each with its schemas.
 *
 * @consumedBy the daemon's `browser.*` handlers
 */
export const BROWSER_METHOD_DESCRIPTORS: BrowserMethodDescriptors = defineMethodDescriptors({
  "browser.siteDataList": {
    method: "browser.siteDataList",
    procedureType: "query",
    mutating: false,
    requestSchema: BrowserMachineRequestSchema,
    responseSchema: BrowserSiteDataListResponseSchema,
  },
  "browser.siteSignIn": {
    method: "browser.siteSignIn",
    procedureType: "mutation",
    mutating: true,
    requestSchema: BrowserSiteRequestSchema,
    responseSchema: BrowserSiteSignInResponseSchema,
  },
  "browser.siteCookiesClear": {
    method: "browser.siteCookiesClear",
    procedureType: "mutation",
    mutating: true,
    requestSchema: BrowserSiteRequestSchema,
    responseSchema: BrowserSiteCookiesClearResponseSchema,
  },
  "browser.siteDataForget": {
    method: "browser.siteDataForget",
    procedureType: "mutation",
    mutating: true,
    requestSchema: BrowserSiteRequestSchema,
    responseSchema: BrowserSiteDataForgetResponseSchema,
  },
  "browser.siteDataClear": {
    method: "browser.siteDataClear",
    procedureType: "mutation",
    mutating: true,
    requestSchema: BrowserMachineRequestSchema,
    responseSchema: BrowserSiteDataClearResponseSchema,
  },
  "browser.chromiumRead": {
    method: "browser.chromiumRead",
    procedureType: "query",
    mutating: false,
    requestSchema: BrowserMachineRequestSchema,
    responseSchema: BrowserChromiumReadResponseSchema,
  },
  "browser.chromiumFetch": {
    method: "browser.chromiumFetch",
    procedureType: "mutation",
    mutating: true,
    requestSchema: BrowserMachineRequestSchema,
    responseSchema: BrowserChromiumFetchResponseSchema,
  },
});
