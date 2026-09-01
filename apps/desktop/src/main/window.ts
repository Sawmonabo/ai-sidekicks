// `BrowserWindow` factories for the Electron main process.
//
// One private function, `constructLockedWindow`, owns the `webPreferences`
// literal — the verbatim `Spec-023 §Security Hardening Baseline` lock-in — so
// the build-time assertion (`apps/desktop/build/assert-webprefs.ts`) covers the
// main window and every auxiliary window through a single block, and asserts
// that block appears EXACTLY ONCE so a second factory cannot smuggle in a
// second, unchecked one. Any drift fails `pnpm build` before the bundle ships.
// That assertion is the enforcement mechanism for `Plan-023 §Done Checklist`
// and `Spec-023 §Pitfalls To Avoid` (`nodeIntegration: true` or
// `sandbox: false` MUST be a build-time error), and it is what Plan-023 I-023-2
// rests on.
//
// Plan-023 Phase 1B (T-023p-1B-2) added the load and the auxiliary factory. The
// window is served over `sidekicks-renderer://`, never `file://`, because
// `Spec-023 §Security Hardening Baseline` disables the
// `GrantFileProtocolExtraPrivileges` fuse — see `./protocol.ts` for the scheme
// registration and the handler.
//
// Preload path: resolved relative to `import.meta.dirname` so the factory
// works under the `electron-vite build` output layout (`out/main/index.js`
// → `out/preload/index.cjs`).
//
// Why `import.meta.dirname` and NOT a `__dirname` reconstruction:
//   At Plan-023 Phase 1 T-023p-1-7 the build pipeline swapped from `tsc -b`
//   to `electron-vite build` (electron-vite v5). electron-vite's `esmShim`
//   plugin (chunks/lib-q6ns0vZr.js line 812:
//   `const CJSShim = supportImportMetaPaths() ? CJSShim_node_20_11 : CJSShim_normal;`)
//   auto-injects a CommonJS shim into ESM-target bundles whenever it
//   detects a `__filename` / `__dirname` / `require(` token in user code
//   (lines 786 + 818-819: `CJSyntaxRe = /__filename|__dirname|require\(|require\.resolve\(/`
//   tested in `renderChunk`). The shim variant is gated on
//   `supportImportMetaPaths()` (lines 137-139: `parseInt(majorVer) >= 30`,
//   reading the bundled Electron major version). We target Electron 44
//   (ADR-016), so the active shim is `CJSShim_node_20_11` (lines 796-802):
//
//     const __filename = import.meta.filename;
//     const __dirname  = import.meta.dirname;
//     const require    = __cjs_mod__.createRequire(import.meta.url);
//
//   On Electron < 30 the plugin falls back to `CJSShim_normal` (lines
//   787-795), which derives `__filename` from `fileURLToPath(import.meta.url)`
//   instead — equivalent semantics, slightly older Node target.
//
//   In either branch, if THIS file ALSO declared `const __filename = …`
//   at module scope, the two would collide as `SyntaxError: Identifier
//   '__filename' has already been declared` at app boot (verified
//   empirically — see Phase 1 T-023p-1-7 commit body). Sticking to
//   `import.meta.dirname` directly keeps the source bundler-agnostic and
//   avoids triggering the shim's `CJSyntaxRe` detection altogether.
//
// Why `.cjs` (not `.js`) for the preload filename:
//   Electron's sandboxed preload runtime (`sandbox: true` below) ONLY
//   supports CommonJS — verified empirically on Electron 41.6.1 and still
//   true on the 44.x pin (Plan-023 T-023p-1B-4): an
//   ESM preload fails to register with `"SyntaxError: Cannot use import
//   statement outside a module"`. The explicit `.cjs` extension overrides
//   the package-level `"type": "module"` so Node loads the file as CJS
//   regardless of the package field. See `electron.vite.config.ts` header.

import { app, BrowserWindow } from "electron";
import path from "node:path";
import { z } from "zod";

import { SessionIdSchema } from "@ai-sidekicks/contracts";

import { RENDERER_INDEX_URL } from "./protocol.js";

/**
 * The auxiliary windows `Spec-023 §Main Process Responsibilities` names — the
 * full-screen timeline and the detached agent console. A CLOSED set: the
 * console's pane-kind set is closed, and only these two panes may be moved into
 * a window of their own (`Spec-023 §Console Design (Meridian)` §The surface set).
 */
export type AuxiliaryWindowRoute = "timeline" | "agent-console";

/**
 * What to open an auxiliary window on: the route, plus the pane context a
 * detach carries.
 *
 * Two shapes, not one optional bag, because the two routes do not take the same
 * context: a detached agent console is meaningless without the agent it is a
 * console FOR, so on that route an `agentId` is required the moment any context
 * is present. The menu-bar path carries no context at all — it has no pane to
 * read one from — and opens the bare route, leaving the choice to the auxiliary
 * renderer's own context picker (Phase 1C).
 */
export type AuxiliaryWindowLaunch =
  | { readonly route: "timeline"; readonly sessionId?: string }
  | {
      readonly route: "agent-console";
      readonly sessionId?: string;
      readonly agentId?: string;
    };

/**
 * Refusal raised when a launch descriptor does not validate.
 *
 * A distinct class rather than a bare `Error` so a caller can tell a rejected
 * descriptor from a window that failed to construct, and so the message can
 * stay free of the offending value — an id that failed a shape check is
 * untrusted input, and echoing it into a log is how untrusted input reaches a
 * log reader.
 */
export class InvalidAuxiliaryWindowLaunchError extends Error {
  public constructor(reason: string) {
    super(`invalid auxiliary window launch: ${reason}`);
    this.name = "InvalidAuxiliaryWindowLaunchError";
  }
}

const PRELOAD_PATH = path.join(import.meta.dirname, "../preload/index.cjs");

interface LockedWindowOptions {
  readonly width: number;
  readonly height: number;
}

/**
 * The single owner of the locked `webPreferences` block.
 *
 * Every window this process creates is constructed here, so the build-time
 * assertion covers all of them by covering one literal. Keep this the only
 * `new BrowserWindow(...)` call site in the package.
 */
function constructLockedWindow(options: LockedWindowOptions): BrowserWindow {
  const browserWindow = new BrowserWindow({
    width: options.width,
    height: options.height,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      preload: PRELOAD_PATH,
    },
  });

  browserWindow.once("ready-to-show", () => {
    browserWindow.show();
  });

  return browserWindow;
}

/**
 * Resolves the document URL a window loads.
 *
 * This is the ONE place `ELECTRON_RENDERER_URL` is read. Under
 * `electron-vite dev` both conditions hold and the dev server is loaded so HMR
 * works; in a packaged app, or with no dev server running, the built bundle is
 * loaded over the renderer scheme. The two origins differ, so IndexedDB
 * partitions differ between `electron-vite dev` and the built bundle — accepted
 * and stated, because the console's persistence layer keys nothing on origin
 * and every console test tier runs the built bundle.
 */
function resolveRendererDocumentUrl(routeFragment: string): string {
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServerUrl !== undefined && devServerUrl !== "") {
    return `${devServerUrl}${routeFragment}`;
  }
  return `${RENDERER_INDEX_URL}${routeFragment}`;
}

/** The main session window. */
export function createMainWindow(): BrowserWindow {
  const browserWindow = constructLockedWindow({ width: 1280, height: 800 });

  loadDocument(browserWindow, resolveRendererDocumentUrl(""));

  return browserWindow;
}

// The two id validators.
//
// `SessionIdSchema` is the contracts package's own branded schema and is used
// verbatim. `AgentId` has no canonical brand yet — its home is Plan-016's
// unshipped `packages/contracts/src/orchestration.ts`, and minting a second
// branded schema here would be the duplicate source of truth that contracts
// file's existing branded-id doctrine forbids — so the agent id is UUID-shape
// validated at the seam, the same treatment `provider-driver.ts` gives its own
// `agentId` member for the same reason. Nothing here re-implements a check the
// corpus already exports.
const AgentIdShapeSchema = z.string().uuid();

/** The closed route set, as a runtime membership test for untrusted input. */
const AUXILIARY_WINDOW_ROUTES: ReadonlySet<string> = new Set<string>(["timeline", "agent-console"]);

/**
 * Validates a launch descriptor and renders it as a route fragment.
 *
 * Runs to completion BEFORE any window is constructed, so a malformed
 * descriptor costs a throw and not a live `BrowserWindow` already pointed at a
 * URL the renderer then has to defend itself against. Every id is checked by
 * shape in the main process — the trusted side — rather than taken on the
 * caller's word, because the fragment is the one part of the loaded URL a
 * caller controls. The route is re-checked at runtime for the same reason: the
 * compile-time union binds this package's own call sites, and the renderer-side
 * detach on `Plan-023 §Console growth slate` will arrive over IPC, where a type
 * is a claim and not a guarantee.
 */
function resolveAuxiliaryRouteFragment(launch: AuxiliaryWindowLaunch): string {
  const route: string = launch.route;
  if (!AUXILIARY_WINDOW_ROUTES.has(route)) {
    throw new InvalidAuxiliaryWindowLaunchError("unknown route");
  }

  const { sessionId } = launch;
  const agentId = launch.route === "agent-console" ? launch.agentId : undefined;

  if (sessionId === undefined) {
    // No context at all is the menu-bar shape. An agent id with no session to
    // read it in is not a partial descriptor, it is an incoherent one.
    if (agentId !== undefined) {
      throw new InvalidAuxiliaryWindowLaunchError("agentId supplied without sessionId");
    }
    return `#/window/${route}`;
  }

  if (!SessionIdSchema.safeParse(sessionId).success) {
    throw new InvalidAuxiliaryWindowLaunchError("sessionId is not a canonical UUID");
  }

  if (launch.route === "timeline") {
    return `#/window/${route}/${sessionId}`;
  }

  // Context on the agent-console route is only meaningful with the agent: a
  // console window is a console FOR something.
  if (agentId === undefined) {
    throw new InvalidAuxiliaryWindowLaunchError("agent-console context requires an agentId");
  }
  if (!AgentIdShapeSchema.safeParse(agentId).success) {
    throw new InvalidAuxiliaryWindowLaunchError("agentId is not a canonical UUID");
  }
  return `#/window/${route}/${sessionId}/${agentId}`;
}

/**
 * An auxiliary window: the same locked factory, the same bundle, at a window
 * route (Plan-023 I-023-12).
 *
 * It holds no reference to the main window and reads none of its state — it is
 * constructed, pointed at a route, and handed back. Because it mints its own
 * preload, it gets its own `contextBridge` instance and therefore its own
 * bridge; it subscribes to the daemon itself and shares no in-memory store with
 * any other window.
 *
 * Throws `InvalidAuxiliaryWindowLaunchError` on a malformed descriptor, before
 * constructing anything.
 */
export function createAuxiliaryWindow(launch: AuxiliaryWindowLaunch): BrowserWindow {
  // Deliberately first: validation must not leave a window behind.
  const routeFragment = resolveAuxiliaryRouteFragment(launch);

  const browserWindow = constructLockedWindow({ width: 1100, height: 760 });

  // A crashed auxiliary window is closed and disposed rather than left as an
  // empty frame. Deliberately NOT registered on the main window: closing that
  // one on a renderer crash would fire `window-all-closed` and quit the
  // application out from under the user, and main-window crash handling belongs
  // to the Tier-8 crash reporter. The main window is told nothing about this
  // crash — the pane-error slot `Spec-023 §Console Design (Meridian)` names is
  // fed by the window-control bridge namespace on `Plan-023 §Console growth
  // slate`, not by an ad-hoc channel minted here.
  browserWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      `[ai-sidekicks/desktop] auxiliary window renderer gone ` +
        `(route=${launch.route}, reason=${details.reason}, exitCode=${String(details.exitCode)})`,
    );
    if (!browserWindow.isDestroyed()) {
      browserWindow.destroy();
    }
  });

  loadDocument(browserWindow, resolveRendererDocumentUrl(routeFragment));

  return browserWindow;
}

/**
 * Starts the load and reports a failure rather than dropping it.
 *
 * `loadURL` rejects on a navigation failure (a refused asset, a handler that
 * never installed). An unhandled rejection here would leave a blank window and
 * no record of why, so the rejection is logged. Structured logging routes
 * through Sentry main at the Tier-8 remainder; until then, stderr.
 */
function loadDocument(browserWindow: BrowserWindow, documentUrl: string): void {
  browserWindow.loadURL(documentUrl).catch((error: unknown) => {
    console.error(`[ai-sidekicks/desktop] failed to load ${documentUrl}:`, error);
  });
}
