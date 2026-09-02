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

// Deep import, deliberately. The contracts barrel re-exports 24 modules, none
// of which Rollup can drop: every schema is a top-level factory call, which a
// bundler must treat as potentially side-effectful. Importing the barrel for
// one branded id put 233 kB of unreachable wire schemas into the main-process
// bundle — a startup-path cost on the process `Spec-023 §Console Design
// (Meridian)` holds to "light on the machine". The `./session` subpath is
// declared in `packages/contracts/package.json` with the same three conditions
// as the barrel, so source resolution under vitest and dist resolution in a
// build both behave exactly as they do for `.`.
import { SessionIdSchema } from "@ai-sidekicks/contracts/session";

import {
  formatAuxiliaryFragment,
  IMPLEMENTED_AUXILIARY_ROUTES,
  isAuxiliaryRouteName,
  type AuxiliaryRouteName,
  type AuxiliaryRouteTarget,
} from "../shared/auxiliary-routes.js";
import { classifyNavigation, openExternalUrl, type InWindowOrigin } from "./navigation.js";
import {
  buildLoadFailureUrl,
  RENDERER_HOST,
  RENDERER_INDEX_URL,
  RENDERER_SCHEME,
} from "./protocol.js";

// The closed route set, the implemented subset, and the fragment shape all live
// in `../shared/auxiliary-routes.ts`, which the renderer imports too — see that
// module's header for why the "which routes exist" answer cannot live in a
// main-process registry. Re-exported here so a caller reaching for the window
// factory needs no second import for the type of the thing it opens.
export type { AuxiliaryRouteName } from "../shared/auxiliary-routes.js";

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

/**
 * Which window a load belongs to, which decides what a total load failure costs.
 *
 * The main window's document IS the application: if not even the generated
 * failure document can be served for it, there is nothing left to interact with
 * and the process exits non-zero rather than sitting there as an invisible
 * placeholder a harness can only detect by timing out. An auxiliary window is a
 * detached pane; the same total failure destroys that window and leaves the
 * application running, because quitting the app because a detached console
 * failed would be the worse outcome.
 */
type WindowRole = "main" | "auxiliary";

/** An admitted launch: the geometry it opens at, and its route fragment. */
interface ResolvedAuxiliaryLaunch {
  readonly geometry: LockedWindowOptions;
  readonly routeFragment: string;
}

interface LockedWindowOptions {
  readonly width: number;
  readonly height: number;
}

/**
 * The size each auxiliary route opens at.
 *
 * Main-process data, so it lives in the main process. Window geometry is
 * meaningless to the renderer bundle — it cannot size its own window — and a
 * value shipped into a bundle that has no use for it is a shared module earning
 * its name by holding everything rather than by holding what is shared.
 *
 * A TOTAL `Record` over the closed route set, deliberately: adding a route to
 * `AUXILIARY_ROUTE_NAMES` is a compile error here until its size is decided, so
 * a new route cannot reach a window through a silent default. The same totality
 * on `AUXILIARY_ROUTE_LABELS` (shared) and the menu's accelerator record makes
 * that true at all three sites a route needs a decision.
 *
 * The timeline is wide because it renders a full-width event stream; the agent
 * console is taller than it is wide because it renders a single column.
 */
const AUXILIARY_WINDOW_GEOMETRY: Record<AuxiliaryRouteName, LockedWindowOptions> = {
  timeline: { width: 1100, height: 760 },
  "agent-console": { width: 980, height: 720 },
};

/**
 * Exit status when a window has no document it can serve — not even the
 * generated failure document.
 *
 * Joins the vocabulary `main/index.ts` already uses on its own exit paths (`0`
 * clean, `1` startup failed, `2` renderer probe failed, `4` index fetch
 * failed), so a harness reading the code can tell this apart from a probe
 * failure instead of seeing an undifferentiated `1`.
 */
export const RENDERER_UNSERVABLE_EXIT_CODE = 5;

/**
 * The origins a window may navigate within, evaluated per navigation.
 *
 * Per navigation and not once at construction, because the dev branch reads the
 * environment and a window outlives the moment it was built. The renderer scheme
 * is always in the set; the dev-server origin joins it only under the same
 * two-condition branch that decides what gets LOADED, so the allowed set and the
 * loaded document can never disagree.
 */
function inWindowOrigins(): readonly InWindowOrigin[] {
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
 * Installs the navigation policy on one window (Plan-023 I-023-2).
 *
 * Both seams live here rather than in the factories, so a future factory cannot
 * construct a locked window that is nevertheless free to navigate anywhere —
 * the locked `webPreferences` block and the navigation policy are installed by
 * the same private function or by neither.
 */
function installNavigationPolicy(browserWindow: BrowserWindow): void {
  browserWindow.webContents.on("will-navigate", (event: Electron.Event, targetUrl: string) => {
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
    console.warn(`[ai-sidekicks/desktop] refused an in-window navigation: ${verdict.reason}`);
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

  installNavigationPolicy(browserWindow);

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

/**
 * How a caller attaches to a window before its load begins.
 *
 * Every load-lifecycle event a caller cares about — `did-finish-load`,
 * `did-fail-load`, `dom-ready` — is emitted by a load these factories start
 * themselves. A caller that registers after the factory returns is relying on
 * Electron emitting on a later tick: true today, and a guarantee nobody wrote
 * down. `beforeLoad` moves that from timing to construction. It is invoked with
 * the constructed window as the last act before `loadURL`, so a listener
 * registered inside it cannot be late.
 *
 * The window is NOT handed back unloaded with a separate load call instead,
 * because that spreads the same ordering obligation across two call sites and
 * lets a caller get it wrong in a new way — load first, attach after — while
 * also making "forgot to load at all" representable. One call that cannot be
 * mis-sequenced is the stronger shape.
 *
 * A throw from `beforeLoad` destroys the window rather than leaving a live,
 * blank, unloaded one behind — the same rule the auxiliary factory's
 * pre-construction validation follows.
 */
export interface WindowLoadOptions {
  readonly beforeLoad?: (browserWindow: BrowserWindow) => void;
}

/**
 * Runs the caller's pre-load hook, then starts the load.
 *
 * Shared by both factories so neither can drift into the ordering the hook
 * exists to guarantee.
 */
function prepareAndLoad(
  browserWindow: BrowserWindow,
  documentUrl: string,
  role: WindowRole,
  options: WindowLoadOptions,
): void {
  try {
    options.beforeLoad?.(browserWindow);
  } catch (error: unknown) {
    if (!browserWindow.isDestroyed()) {
      browserWindow.destroy();
    }
    throw error;
  }

  loadDocument(browserWindow, documentUrl, role);
}

/** The main session window. */
export function createMainWindow(options: WindowLoadOptions = {}): BrowserWindow {
  const browserWindow = constructLockedWindow({ width: 1280, height: 800 });

  prepareAndLoad(browserWindow, resolveRendererDocumentUrl(""), "main", options);

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
function resolveAuxiliaryLaunch(launch: AuxiliaryWindowLaunch): ResolvedAuxiliaryLaunch {
  // Two conditions, one refusal, because from a window's point of view they are
  // the same condition — nothing to show. A route outside the closed set is not
  // a route at all; a route the closed set carries but this build does not
  // IMPLEMENT has no renderer body, so a window would open on an empty hash
  // route: a blank frame the user has to close.
  if (!isAuxiliaryRouteName(launch.route) || !IMPLEMENTED_AUXILIARY_ROUTES.includes(launch.route)) {
    throw new InvalidAuxiliaryWindowLaunchError("unknown route");
  }
  const geometry = AUXILIARY_WINDOW_GEOMETRY[launch.route];

  const { sessionId } = launch;
  const agentId = launch.route === "agent-console" ? launch.agentId : undefined;

  if (sessionId === undefined) {
    // No context at all is the menu-bar shape. An agent id with no session to
    // read it in is not a partial descriptor, it is an incoherent one.
    if (agentId !== undefined) {
      throw new InvalidAuxiliaryWindowLaunchError("agentId supplied without sessionId");
    }
    return { geometry, routeFragment: formatAuxiliaryFragment({ route: launch.route }) };
  }

  if (!SessionIdSchema.safeParse(sessionId).success) {
    throw new InvalidAuxiliaryWindowLaunchError("sessionId is not a canonical UUID");
  }

  if (launch.route === "timeline") {
    return {
      geometry,
      routeFragment: formatAuxiliaryFragment({ route: launch.route, sessionId }),
    };
  }

  // Context on the agent-console route is only meaningful with the agent: a
  // console window is a console FOR something.
  if (agentId === undefined) {
    throw new InvalidAuxiliaryWindowLaunchError("agent-console context requires an agentId");
  }
  if (!AgentIdShapeSchema.safeParse(agentId).success) {
    throw new InvalidAuxiliaryWindowLaunchError("agentId is not a canonical UUID");
  }
  const target: AuxiliaryRouteTarget = { route: launch.route, sessionId, agentId };
  return { geometry, routeFragment: formatAuxiliaryFragment(target) };
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
export function createAuxiliaryWindow(
  launch: AuxiliaryWindowLaunch,
  options: WindowLoadOptions = {},
): BrowserWindow {
  // Deliberately first: validation must not leave a window behind.
  const { geometry, routeFragment } = resolveAuxiliaryLaunch(launch);

  const browserWindow = constructLockedWindow(geometry);

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

  prepareAndLoad(browserWindow, resolveRendererDocumentUrl(routeFragment), "auxiliary", options);

  return browserWindow;
}

/**
 * Renders an unknown thrown value as a bounded, single-line reason.
 *
 * `unknown` because a rejected `loadURL` is not guaranteed to reject with an
 * `Error`, and `String(error)` on a hostile object can be arbitrarily long or
 * multi-line. Newlines collapse so the reason stays one log line and one
 * paragraph in the failure document.
 */
function describeLoadFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Starts the load, and gives a rejected load a visible, controlled outcome.
 *
 * `loadURL` rejects on a navigation failure (a refused asset, a handler that
 * never installed, a bundle that is not there). Logging and returning left a
 * LIVE, BLANK, RETAINED window: nothing on screen, no reason, and nothing for
 * the user or a harness to act on. Instead the window loads the generated
 * failure document (`protocol.ts`), which carries the reason and is servable
 * precisely because it is not read from the tree that just failed.
 *
 * If that second load also rejects, no document can be served at all: the window
 * is destroyed rather than retained, and for the main window the process exits
 * non-zero with the diagnostic. There is no third attempt — the failure
 * document's own catch does not re-enter this path, so the recovery cannot loop.
 */
function loadDocument(browserWindow: BrowserWindow, documentUrl: string, role: WindowRole): void {
  browserWindow.loadURL(documentUrl).catch((error: unknown) => {
    const reason = describeLoadFailure(error);
    console.error(`[ai-sidekicks/desktop] failed to load ${documentUrl}: ${reason}`);
    serveLoadFailureDocument(browserWindow, role, reason);
  });
}

/** Loads the generated failure document, or gives up in a controlled way. */
function serveLoadFailureDocument(
  browserWindow: BrowserWindow,
  role: WindowRole,
  reason: string,
): void {
  if (browserWindow.isDestroyed()) {
    // The window went away while the load was failing. Nothing to show it on.
    abandonUnservableWindow(browserWindow, role, reason);
    return;
  }

  browserWindow.loadURL(buildLoadFailureUrl(reason)).catch((failureDocumentError: unknown) => {
    console.error(
      `[ai-sidekicks/desktop] the load-failure document could not be served: ` +
        `${describeLoadFailure(failureDocumentError)}`,
    );
    abandonUnservableWindow(browserWindow, role, reason);
  });
}

/** Destroys a window that has no document, and exits if it was the main one. */
function abandonUnservableWindow(
  browserWindow: BrowserWindow,
  role: WindowRole,
  reason: string,
): void {
  if (!browserWindow.isDestroyed()) {
    browserWindow.destroy();
  }
  if (role !== "main") {
    return;
  }
  console.error(
    `[ai-sidekicks/desktop] no renderer document could be served for the main window ` +
      `(${reason}); exiting ${String(RENDERER_UNSERVABLE_EXIT_CODE)}.`,
  );
  app.exit(RENDERER_UNSERVABLE_EXIT_CODE);
}
