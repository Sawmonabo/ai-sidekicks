// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The machine-wide browser methods behind Settings › Browser.

import type { WireInstant } from "./internal/wire-scalars.js";
import type { EmptyPayload } from "./method-descriptor.js";

/**
 * A site's origin: an http(s) origin, scheme://host[:port].
 */
export type SiteOrigin = string;
/**
 * An installed Chromium that runs pages: the desktop app's own, or an installed Chrome or Edge.
 */
export type BrowserInstalledChromiumSource = "desktop" | "chrome" | "edge";
/**
 * Why the daemon's headless Chromium cannot start on this machine.
 */
export type BrowserChromiumCannotStartReason = "missingSystemLibraries";
/**
 * The Chromium in use, its version, and when it was fetched; `fetchedAt` is set exactly when the
 * source is the fetched one.
 */
export type BrowserChromiumReadResponse =
  | {
      /**
       * The fetched Chromium.
       */
      source: "chromeForTesting";
      /**
       * When it was fetched.
       */
      fetchedAt: WireInstant;
      /**
       * Its version.
       */
      version: string;
      /**
       * Why the headless Chromium cannot start here, or `null`.
       */
      cannotStart: BrowserChromiumCannotStart | null;
    }
  | {
      /**
       * Which one.
       */
      source: BrowserInstalledChromiumSource;
      /**
       * Always `null`: only a fetched Chromium has a fetch time.
       */
      fetchedAt: null;
      /**
       * Its version.
       */
      version: string;
      /**
       * Why the headless Chromium cannot start here, or `null`.
       */
      cannotStart: BrowserChromiumCannotStart | null;
    };

/**
 * One site holding saved data. `hasCookies` is true while it holds at least one unexpired cookie,
 * and the row then reads `Saved cookies`; otherwise it holds other saved data and reads `Saved
 * site data`. Nothing here says whether the person is signed in, because a cookie does not prove
 * a login.
 */
export interface BrowserSiteData {
  /**
   * The site.
   */
  origin: SiteOrigin;
  /**
   * How much it saved, in bytes.
   */
  sizeBytes: number;
  /**
   * When it was last used.
   */
  lastUsedAt: WireInstant;
  /**
   * Whether it holds an unexpired cookie.
   */
  hasCookies: boolean;
}
/**
 * Every site with saved data, one per registrable domain.
 */
export interface BrowserSiteDataListResponse {
  /**
   * The sites.
   */
  sites: BrowserSiteData[];
}
/**
 * Names one site: sign in to it, clear its cookies, or forget it.
 */
export interface BrowserSiteRequest {
  /**
   * The site.
   */
  origin: SiteOrigin;
}
/**
 * The site opened in a page of its own that belongs to no session, over the machine's site data,
 * showing the address line and nothing else. What the site saves there is kept for every browser.
 */
export interface BrowserSiteSignInResponse {
  /**
   * Always true.
   */
  opened: true;
}
/**
 * The site's cookies are gone across its registrable domain, and nothing else: its storage, cache
 * and service workers stay. It claims nothing about signing out.
 */
export interface BrowserCookieClearResponse {
  /**
   * The site.
   */
  origin: SiteOrigin;
  /**
   * Always true.
   */
  cleared: true;
}
/**
 * Every kind of data the site saved is gone; a site holding nothing answers the same.
 */
export interface BrowserSiteDataForgetResponse {
  /**
   * The site.
   */
  origin: SiteOrigin;
  /**
   * Always true.
   */
  forgotten: true;
}
/**
 * Every site's saved data is gone.
 */
export interface BrowserSiteDataClearResponse {
  /**
   * Always true.
   */
  cleared: true;
}
/**
 * The headless Chromium cannot start. `installStep` is the command that installs what it needs
 * for the version the service carries, shown as text and never run, because it needs an
 * administrator.
 */
export interface BrowserChromiumCannotStart {
  /**
   * Why.
   */
  reason: BrowserChromiumCannotStartReason;
  /**
   * The command that fixes it.
   */
  installStep: string;
}
/**
 * The fetch started; its progress is a flow row. A fetch asked for during one joins it.
 */
export interface BrowserChromiumFetchResponse {
  /**
   * Always true.
   */
  started: true;
}

/** The methods of {@link BROWSER_METHOD_DESCRIPTORS}, each with its kind. */
export interface BrowserMethodDescriptors {
  readonly "browser.siteData.list": {
    readonly method: "browser.siteData.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "browser.site.signIn": {
    readonly method: "browser.site.signIn";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "browser.cookie.clear": {
    readonly method: "browser.cookie.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "browser.siteData.forget": {
    readonly method: "browser.siteData.forget";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "browser.siteData.clear": {
    readonly method: "browser.siteData.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "browser.chromium.read": {
    readonly method: "browser.chromium.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "browser.chromium.fetch": {
    readonly method: "browser.chromium.fetch";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link BROWSER_METHOD_DESCRIPTORS}. */
export interface BrowserMethodTypes {
  readonly "browser.siteData.list": {
    readonly params: EmptyPayload;
    readonly result: BrowserSiteDataListResponse;
  };
  readonly "browser.site.signIn": {
    readonly params: BrowserSiteRequest;
    readonly result: BrowserSiteSignInResponse;
  };
  readonly "browser.cookie.clear": {
    readonly params: BrowserSiteRequest;
    readonly result: BrowserCookieClearResponse;
  };
  readonly "browser.siteData.forget": {
    readonly params: BrowserSiteRequest;
    readonly result: BrowserSiteDataForgetResponse;
  };
  readonly "browser.siteData.clear": {
    readonly params: EmptyPayload;
    readonly result: BrowserSiteDataClearResponse;
  };
  readonly "browser.chromium.read": {
    readonly params: EmptyPayload;
    readonly result: BrowserChromiumReadResponse;
  };
  readonly "browser.chromium.fetch": {
    readonly params: EmptyPayload;
    readonly result: BrowserChromiumFetchResponse;
  };
}
/** The `browser.*` methods the daemon answers. */
export const BROWSER_METHOD_DESCRIPTORS: BrowserMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "browser.siteData.list": /* @__PURE__ */ Object.freeze({
    method: "browser.siteData.list",
    procedureType: "query",
    mutating: false,
  }),
  "browser.site.signIn": /* @__PURE__ */ Object.freeze({
    method: "browser.site.signIn",
    procedureType: "mutation",
    mutating: true,
  }),
  "browser.cookie.clear": /* @__PURE__ */ Object.freeze({
    method: "browser.cookie.clear",
    procedureType: "mutation",
    mutating: true,
  }),
  "browser.siteData.forget": /* @__PURE__ */ Object.freeze({
    method: "browser.siteData.forget",
    procedureType: "mutation",
    mutating: true,
  }),
  "browser.siteData.clear": /* @__PURE__ */ Object.freeze({
    method: "browser.siteData.clear",
    procedureType: "mutation",
    mutating: true,
  }),
  "browser.chromium.read": /* @__PURE__ */ Object.freeze({
    method: "browser.chromium.read",
    procedureType: "query",
    mutating: false,
  }),
  "browser.chromium.fetch": /* @__PURE__ */ Object.freeze({
    method: "browser.chromium.fetch",
    procedureType: "mutation",
    mutating: true,
  }),
});
