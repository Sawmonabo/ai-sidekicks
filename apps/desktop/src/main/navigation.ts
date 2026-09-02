// Navigation policy for every window this process constructs — Plan-023 Phase 1B
// (T-023p-1B-2).
//
// `Spec-023 §Security Hardening Baseline` locks the `webPreferences` block, and
// `assert-webprefs.ts` keeps it locked. That block governs what the renderer CAN
// do; it says nothing about where the renderer may GO. A hardened window is
// still a window: a link, a redirect, or a compromised dependency can navigate
// the top-level frame at a remote origin, and from that moment the locked block
// is protecting attacker-served content instead of ours — same preload, same
// bridge, same `sidekicks-renderer://`-partitioned IndexedDB. Electron's own
// security checklist names both halves (limit navigation; limit creation of new
// windows), and neither is on by default.
//
// The policy is one closed classification, applied at three seams:
//
//   `will-navigate`          — top-level navigation the page initiated.
//   `will-redirect`          — a server 3xx steering an admitted navigation
//                              somewhere else. Its own seam because
//                              `will-navigate` fires on the ORIGINAL target: a
//                              request to an admitted origin that answers `302
//                              Location: https://evil.test` was already admitted
//                              by the time the redirect is known, so without
//                              this the document swaps to an unadmitted origin
//                              while keeping the preload, the bridge, and the
//                              partition. It is the same classification and the
//                              same `preventDefault`, deliberately — a redirect
//                              that reaches somewhere a link could not reach
//                              would be a hole shaped exactly like the one the
//                              first seam closes.
//   `setWindowOpenHandler`   — a popup / `window.open` / `target="_blank"`.
//
// Popups are denied UNCONDITIONALLY, same origin included. A second window is
// only ever created here by `createAuxiliaryWindow`, which runs the locked
// factory; a renderer-opened one would be created by Chromium with options this
// process never reviewed, and there is no console surface that needs one.
//
// External `http(s)` targets are not simply dropped: a dropped link is a dead
// link, and the console has legitimate ones (docs, a provider's sign-in page,
// a release note). They go to the OS browser through a MAIN-owned
// `shell.openExternal` call behind a scheme allowlist. Everything else —
// `file:`, `javascript:`, `data:`, `blob:`, a custom scheme some installed app
// registered — is refused with no side effect at all. That closed allowlist is
// the point: `shell.openExternal` hands a string to the operating system's
// handler registry, so an unfiltered call is a local-code-execution primitive,
// not a link.
//
// Pure classification lives in `classifyNavigation`, which touches no Electron
// API, so every arm of the matrix is unit-testable without a window.

import { app, shell, type BrowserWindow } from "electron";

import { RENDERER_HOST, RENDERER_SCHEME } from "./renderer-scheme.js";

/**
 * Schemes a refused in-window navigation may be handed to the OS browser under.
 *
 * `http:` rides beside `https:` because a self-hosted control plane or relay on
 * a LAN is a supported deployment (ADR-020), and its console links are plain
 * HTTP. The browser, not this process, is the
 * security boundary for what happens after the handoff; what this list is for is
 * making sure the handoff is to a BROWSER and not to whatever the OS has
 * registered for `ms-msdt:` this week.
 */
export const EXTERNAL_URL_SCHEME_ALLOWLIST: readonly string[] = ["https:", "http:"];

/**
 * One in-window origin: a scheme and an authority.
 *
 * A pair rather than an origin string because `URL.origin` is `"null"` for every
 * non-special scheme, and `sidekicks-renderer:` is non-special in Node's WHATWG
 * parser (Chromium gives it an origin because the scheme is registered
 * `standard: true` there, but this classification runs in the main process). A
 * comparison on `.origin` would therefore compare `"null"` to `"null"` and admit
 * every non-special scheme in existence.
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
 * Classifies one navigation target against the origins a window may navigate
 * within.
 *
 * Fail-closed at every step: an unparseable target, a credentialed authority, or
 * any scheme outside the two lists is `refused`. Nothing here echoes the target
 * back into the verdict — a refusal reason names the CLASS, so a diagnostic
 * cannot become the log line that carries an attacker's string.
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

  // Credentials in the authority are a phishing shape (`https://app@evil.test`)
  // and no legitimate console target carries them.
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    return { kind: "refused", reason: "navigation target carries credentials" };
  }

  const host = parsedUrl.host.toLowerCase();
  const protocol = parsedUrl.protocol.toLowerCase();

  for (const origin of inWindowOrigins) {
    if (origin.protocol.toLowerCase() === protocol && origin.host.toLowerCase() === host) {
      return IN_WINDOW;
    }
  }

  if (EXTERNAL_URL_SCHEME_ALLOWLIST.includes(protocol)) {
    return EXTERNAL;
  }

  return { kind: "refused", reason: "navigation target is outside every allowed scheme" };
}

/**
 * Hands an allowlisted external target to the OS browser.
 *
 * Deferred by one turn: `setWindowOpenHandler` runs synchronously inside
 * Chromium's window-open path, and Electron's own security guidance opens
 * externally from a deferred callback rather than re-entering the browser
 * process from inside that call. `setImmediate` is a one-shot callback, not a
 * repeating timer — nothing here keeps the event loop alive past the open.
 *
 * The scheme is re-checked here rather than trusted from the caller's verdict.
 * This function is the single place a URL reaches `shell.openExternal`, and a
 * guard that only holds when the caller remembered to classify first is not a
 * guard.
 */
export function openExternalUrl(targetUrl: string): void {
  const verdict = classifyNavigation(targetUrl, []);
  if (verdict.kind !== "external") {
    console.error(
      `[ai-sidekicks/desktop] refused to open an external URL: ${
        verdict.kind === "refused" ? verdict.reason : "target is an in-window origin"
      }`,
    );
    return;
  }

  setImmediate(() => {
    shell.openExternal(targetUrl).catch((error: unknown) => {
      // The OS declined to open it. Nothing to retry and nothing to fall back
      // to; structured logging routes through Sentry main at the Tier-8
      // remainder, and until then this is the record.
      console.error("[ai-sidekicks/desktop] shell.openExternal failed:", error);
    });
  });
}

/**
 * The origins a window may navigate within, evaluated per navigation.
 *
 * Per navigation and not once at construction, because the dev branch reads the
 * environment and a window outlives the moment it was built. The renderer scheme
 * is always in the set; the dev-server origin joins it only under the same
 * two-condition branch that decides what gets LOADED (see
 * `./window.ts`'s `resolveRendererDocumentUrl`), so the allowed set and the
 * loaded document can never disagree.
 */
export function inWindowOrigins(): readonly InWindowOrigin[] {
  const origins: InWindowOrigin[] = [{ protocol: `${RENDERER_SCHEME}:`, host: RENDERER_HOST }];
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServerUrl !== undefined && devServerUrl !== "") {
    try {
      const parsedDevServerUrl = new URL(devServerUrl);
      origins.push({ protocol: parsedDevServerUrl.protocol, host: parsedDevServerUrl.host });
    } catch {
      // A malformed dev-server URL is not loaded either — the load path builds
      // its document from the same string and Chromium refuses it there. Adding
      // nothing here keeps the allowed set narrower than the loaded one, never
      // wider.
    }
  }
  return origins;
}

/**
 * Applies the classification to one navigation attempt.
 *
 * Shared verbatim by `will-navigate` and `will-redirect` so the two seams cannot
 * drift: a redirect target that a link could not reach must not be reachable by
 * being redirected to. `seam` names which one fired, so a refusal log says
 * whether the page asked or a server steered.
 */
function decideNavigation(event: Electron.Event, targetUrl: string, seam: string): void {
  const verdict = classifyNavigation(targetUrl, inWindowOrigins());
  if (verdict.kind === "in-window") {
    return;
  }

  // Deliberately first: the navigation is stopped before anything else is
  // decided, so an exception in the external path cannot leave it running.
  event.preventDefault();

  if (verdict.kind === "external") {
    openExternalUrl(targetUrl);
    return;
  }
  console.warn(`[ai-sidekicks/desktop] refused an in-window ${seam}: ${verdict.reason}`);
}

/**
 * Installs the navigation policy on one window (Plan-023 I-023-2).
 *
 * Called from the locked window factory rather than from each caller, so a
 * future factory cannot construct a locked window that is nevertheless free to
 * navigate anywhere — the locked `webPreferences` block and this policy are
 * installed by the same private function or by neither.
 */
export function installNavigationPolicy(browserWindow: BrowserWindow): void {
  browserWindow.webContents.on("will-navigate", (event: Electron.Event, targetUrl: string) => {
    decideNavigation(event, targetUrl, "navigation");
  });

  browserWindow.webContents.on("will-redirect", (event: Electron.Event, targetUrl: string) => {
    decideNavigation(event, targetUrl, "redirect");
  });

  browserWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    // Every popup is denied. The only second window this process creates is
    // `createAuxiliaryWindow`'s, which runs the locked factory; a
    // Chromium-created one would carry options nothing here reviewed.
    const verdict = classifyNavigation(url, inWindowOrigins());
    if (verdict.kind === "external") {
      openExternalUrl(url);
    } else if (verdict.kind === "refused") {
      console.warn(`[ai-sidekicks/desktop] refused a popup: ${verdict.reason}`);
    }
    return { action: "deny" };
  });
}
