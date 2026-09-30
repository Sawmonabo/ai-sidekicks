// Navigation policy for every window this process constructs. The locked `webPreferences`
// block (kept locked by `apps/desktop/build/assert-webprefs.ts`) governs what the renderer can
// do, not where it may go: a link, a redirect or a compromised dependency can navigate the
// top-level frame to a remote origin, which would then run with the same preload, bridge and
// storage partition. Electron's security checklist names both halves (limit navigation, limit
// new windows) and neither is on by default.
//
// One closed classification is applied at three seams:
//
//   `will-navigate`          top-level navigation the page initiated.
//   `will-redirect`          a server 3xx steering an admitted navigation elsewhere. Its own
//                            seam because `will-navigate` fires on the original target, so
//                            without it an admitted origin could answer `302 Location:
//                            https://evil.test` and the document would swap origins while
//                            keeping the preload and bridge. Same classification, same
//                            `preventDefault`.
//   `setWindowOpenHandler`   a popup, `window.open` or `target="_blank"`.
//
// Popups are denied unconditionally, same origin included: Chromium would create the window
// with options this process never reviewed, and nothing the renderer draws needs one.
//
// External `http(s)` targets go to the OS browser through a main-owned `shell.openExternal`
// call behind a scheme allowlist. Everything else (`file:`, `javascript:`, `data:`, `blob:`, a
// custom scheme another app registered) is refused with no side effect, because
// `shell.openExternal` hands a string to the OS handler registry and an unfiltered call is a
// local-code-execution primitive.
//
// `classifyNavigation` is pure and touches no Electron API, so every arm is unit-testable.

import { webAddressFault } from "@ai-sidekicks/contracts/web-address";
import { app, shell, type BrowserWindow } from "electron";

import { RENDERER_HOST, RENDERER_SCHEME } from "../services/renderer-scheme.js";

/**
 * One in-window origin: a scheme and an authority. A pair rather than an origin string because
 * `URL.origin` is `"null"` for every non-special scheme, and `sidekicks-renderer:` is
 * non-special in Node's WHATWG parser, so comparing `.origin` would admit every non-special
 * scheme.
 */
export interface InWindowOrigin {
  readonly protocol: string;
  readonly host: string;
}

/** What a window may do with a navigation target. */
export type NavigationVerdict =
  | { readonly kind: "in-window" }
  | { readonly kind: "external" }
  | { readonly kind: "refused"; readonly reason: string };

const IN_WINDOW: NavigationVerdict = { kind: "in-window" };
const EXTERNAL: NavigationVerdict = { kind: "external" };

/**
 * Classifies one navigation target against the origins a window may navigate within.
 * Fail-closed: an unparseable target, a credentialed authority, or a scheme that is neither an
 * in-window origin nor a web address is `refused`. Web addresses are `http:` or `https:` only,
 * never with a username or password. A refusal reason names the class, never the target, so a
 * log line cannot carry an attacker's string.
 */
export function classifyNavigation(
  targetUrl: string,
  inWindowOrigins: readonly InWindowOrigin[],
): NavigationVerdict {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return { kind: "refused", reason: "unparseable navigation target" };
  }

  const fault = webAddressFault(parsedUrl);
  // Credentials in the authority are a phishing shape (`https://app@evil.test`).
  if (fault === "credentials") {
    return { kind: "refused", reason: "navigation target carries credentials" };
  }

  const host = parsedUrl.host.toLowerCase();
  const protocol = parsedUrl.protocol.toLowerCase();

  for (const origin of inWindowOrigins) {
    if (origin.protocol.toLowerCase() === protocol && origin.host.toLowerCase() === host) {
      return IN_WINDOW;
    }
  }

  if (fault === null) {
    return EXTERNAL;
  }

  return { kind: "refused", reason: "navigation target is outside every allowed scheme" };
}

/**
 * Hands a web address to the OS browser, and rejects when it may not be handed. Deferred by one
 * turn because `setWindowOpenHandler` runs inside Chromium's window-open path, and Electron's
 * security guidance opens externally from a deferred callback. The target is re-classified
 * here because this is the single place a URL reaches `shell.openExternal`; a guard that
 * depends on the caller classifying first is not a guard. The rejection names the class, not
 * the target.
 */
export async function openExternalUrl(targetUrl: string): Promise<void> {
  const verdict = classifyNavigation(targetUrl, []);
  if (verdict.kind !== "external") {
    throw new Error(
      `Refused to open an outside address: ${
        verdict.kind === "refused" ? verdict.reason : "target is an in-window origin"
      }.`,
    );
  }
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await shell.openExternal(targetUrl);
}

/**
 * Opens a link the window itself asked for, from a seam with no caller to hand a failure to:
 * the refusal or the OS failure is logged, and that log is the record.
 */
function openExternalFromWindow(targetUrl: string): void {
  openExternalUrl(targetUrl).catch((error: unknown) => {
    console.error("[ai-sidekicks/desktop] an outside address was not opened:", error);
  });
}

/**
 * The origins a window may navigate within, evaluated per navigation because the dev branch
 * reads the environment and a window outlives its construction. The renderer scheme is always
 * in the set; the dev-server origin joins only under the same condition that decides what
 * `./window.ts` loads, so the allowed set and the loaded document cannot disagree.
 */
export function inWindowOrigins(): readonly InWindowOrigin[] {
  const origins: InWindowOrigin[] = [{ protocol: `${RENDERER_SCHEME}:`, host: RENDERER_HOST }];
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServerUrl !== undefined && devServerUrl !== "") {
    try {
      const parsedDevServerUrl = new URL(devServerUrl);
      origins.push({ protocol: parsedDevServerUrl.protocol, host: parsedDevServerUrl.host });
    } catch {
      // A malformed dev-server URL is not loaded either; adding nothing keeps the allowed set
      // narrower than the loaded one, never wider.
    }
  }
  return origins;
}

/**
 * Applies the classification to one navigation attempt, shared by `will-navigate` and
 * `will-redirect` so a redirect cannot reach what a link could not. `seam` says whether the
 * page asked or a server steered.
 */
function decideNavigation(event: Electron.Event, targetUrl: string, seam: string): void {
  const verdict = classifyNavigation(targetUrl, inWindowOrigins());
  if (verdict.kind === "in-window") {
    return;
  }

  // First, so an exception in the external path cannot leave the navigation running.
  event.preventDefault();

  if (verdict.kind === "external") {
    openExternalFromWindow(targetUrl);
    return;
  }
  console.warn(`[ai-sidekicks/desktop] refused an in-window ${seam}: ${verdict.reason}`);
}

/**
 * Installs the navigation policy on one window. Called from the locked window factory, so the
 * locked `webPreferences` block and this policy are installed together or not at all.
 */
export function installNavigationPolicy(browserWindow: BrowserWindow): void {
  browserWindow.webContents.on("will-navigate", (event: Electron.Event, targetUrl: string) => {
    decideNavigation(event, targetUrl, "navigation");
  });

  browserWindow.webContents.on("will-redirect", (event: Electron.Event, targetUrl: string) => {
    decideNavigation(event, targetUrl, "redirect");
  });

  browserWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    // Every popup is denied: a Chromium-created window would carry unreviewed options.
    const verdict = classifyNavigation(url, inWindowOrigins());
    if (verdict.kind === "external") {
      openExternalFromWindow(url);
    } else if (verdict.kind === "refused") {
      console.warn(`[ai-sidekicks/desktop] refused a popup: ${verdict.reason}`);
    }
    return { action: "deny" };
  });
}
