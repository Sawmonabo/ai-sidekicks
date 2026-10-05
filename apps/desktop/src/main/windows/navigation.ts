// Navigation policy for every window this process constructs. The locked `webPreferences`
// block (held by the window-security rules in `eslint.config.mjs`) governs what the renderer
// can do, not where it may go: a link, a redirect or a compromised dependency can navigate the
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
// Every popup is denied, same origin included, except the renderer's own `window.open` of a blank
// document under a frame name main builds a window for (`./frame-name.ts`). That one is answered
// with main's own `createWindow`, so the window carries main's options and never the ones Chromium
// would have built from the page's request. Only a blank document: the renderer draws into it, and
// a second copy of the console document would be a second renderer with stores of its own.
//
// External `http(s)` targets go to the OS browser through a main-owned `shell.openExternal`
// call behind a scheme allowlist. Everything else (`file:`, `javascript:`, `data:`, `blob:`, a
// custom scheme another app registered) is refused with no side effect, because
// `shell.openExternal` hands a string to the OS handler registry and an unfiltered call is a
// local-code-execution primitive.
//
// `classifyNavigation` is pure and touches no Electron API, so every arm is unit-testable.

import { webAddressFault } from "@ai-sidekicks/contracts/web-address";
import { app, shell, type WebContents } from "electron";

import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import { RENDERER_HOST, RENDERER_SCHEME } from "../services/renderer/scheme.js";

/** Where a refused navigation or an outside address that did not open is recorded. */
type NavigationLog = Pick<MainDiagnosticLog, "write">;

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
 * Fail-closed: an unparseable target, or a scheme that is neither an in-window origin nor a web
 * address, is `refused`. Web addresses are `http:` or `https:` only. A refusal reason names the
 * class, never the target, so a log line cannot carry an attacker's string.
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

  const host = parsedUrl.host.toLowerCase();
  const protocol = parsedUrl.protocol.toLowerCase();

  for (const origin of inWindowOrigins) {
    if (origin.protocol.toLowerCase() === protocol && origin.host.toLowerCase() === host) {
      return IN_WINDOW;
    }
  }

  if (webAddressFault(parsedUrl) === null) {
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
  // With no in-window origins the verdict is `external` or `refused`.
  const verdict = classifyNavigation(targetUrl, []);
  if (verdict.kind === "refused") {
    throw new Error(`Refused to open an outside address: ${verdict.reason}.`);
  }
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await shell.openExternal(targetUrl);
}

/**
 * Opens a link the window itself asked for, from a seam with no caller to hand a failure to:
 * the refusal or the OS failure goes to main's log, and that log is the record.
 */
function openExternalFromWindow(targetUrl: string, log: NavigationLog): void {
  openExternalUrl(targetUrl).catch((error: unknown) => {
    writeNavigationEntry(
      log,
      "error",
      `an outside address was not opened: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function writeNavigationEntry(
  log: NavigationLog,
  level: "error" | "warning",
  message: string,
): void {
  log.write({ at: new Date().toISOString(), level, source: "main/windows/navigation", message });
}

/**
 * The dev server's address, on an unpackaged run that `electron-vite dev` started. The window
 * loads it and navigation admits its origin, so both read this one answer. A malformed address
 * throws, which stops the window at startup instead of loading a document no policy admits.
 */
export function devServerUrl(): URL | undefined {
  const configuredUrl = process.env["ELECTRON_RENDERER_URL"];
  if (app.isPackaged || configuredUrl === undefined || configuredUrl === "") {
    return undefined;
  }
  return new URL(configuredUrl);
}

/**
 * The origins a window may navigate within, evaluated per navigation because the dev branch
 * reads the environment and a window outlives its construction. The renderer scheme is always
 * in the set; the dev server's origin joins when `./window.ts` loads it.
 */
export function inWindowOrigins(): readonly InWindowOrigin[] {
  const origins: InWindowOrigin[] = [{ protocol: `${RENDERER_SCHEME}:`, host: RENDERER_HOST }];
  const devServer = devServerUrl();
  if (devServer !== undefined) {
    origins.push({ protocol: devServer.protocol, host: devServer.host });
  }
  return origins;
}

/**
 * Applies the classification to one navigation attempt, shared by `will-navigate` and
 * `will-redirect` so a redirect cannot reach what a link could not. `seam` says whether the
 * page asked or a server steered.
 */
function decideNavigation(
  event: Electron.Event,
  targetUrl: string,
  seam: string,
  log: NavigationLog,
): void {
  const verdict = classifyNavigation(targetUrl, inWindowOrigins());
  if (verdict.kind === "in-window") {
    return;
  }

  // First, so an exception in the external path cannot leave the navigation running.
  event.preventDefault();

  if (verdict.kind === "external") {
    openExternalFromWindow(targetUrl, log);
    return;
  }
  writeNavigationEntry(log, "warning", `refused a ${seam}: ${verdict.reason}`);
}

/**
 * Builds the window for a renderer `window.open` main answers, and returns the `webContents` it
 * adopted, as `setWindowOpenHandler`'s `createWindow` must; `undefined` for a frame name main
 * builds nothing for.
 */
export type ChildWindowOpener = (
  frameName: string,
) => ((handedWebContents: WebContents) => WebContents) | undefined;

/** The document a child window starts on: blank, written into by the renderer that opened it. */
const BLANK_DOCUMENT_URL = "about:blank";

/**
 * Installs the navigation policy on one window's document. Called from the locked window
 * factory, so the locked `webPreferences` block and this policy are installed together or not at
 * all.
 */
export function installNavigationPolicy(
  webContents: WebContents,
  openChildWindow: ChildWindowOpener,
  log: NavigationLog,
): void {
  webContents.on("will-navigate", (event: Electron.Event, targetUrl: string) => {
    decideNavigation(event, targetUrl, "navigation", log);
  });

  webContents.on("will-redirect", (event: Electron.Event, targetUrl: string) => {
    decideNavigation(event, targetUrl, "redirect", log);
  });

  webContents.setWindowOpenHandler(({ url, frameName }) => {
    const createWindow = url === BLANK_DOCUMENT_URL ? openChildWindow(frameName) : undefined;
    if (createWindow !== undefined) {
      // Electron hands the child's `webContents` in the options; main's own window adopts it.
      return {
        action: "allow",
        createWindow: (options) => createWindow(handedWebContentsOf(options)),
      };
    }
    const verdict = classifyNavigation(url, inWindowOrigins());
    if (verdict.kind === "external") {
      openExternalFromWindow(url, log);
    } else if (verdict.kind === "refused") {
      writeNavigationEntry(log, "warning", `refused a popup: ${verdict.reason}`);
    }
    return { action: "deny" };
  });
}

/**
 * The child `webContents` Electron hands `createWindow`. Electron's type omits the member it
 * passes, so it is read here and its absence throws rather than building an empty window.
 */
function handedWebContentsOf(options: object): WebContents {
  const handed = (options as { readonly webContents?: WebContents }).webContents;
  if (handed === undefined) {
    throw new Error("Electron handed createWindow no webContents to adopt.");
  }
  return handed;
}
