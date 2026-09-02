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
// Three neighbours own the rest of a window's life, split by role rather than
// by size: `./navigation.ts` (which navigations are admitted),
// `./window-load-failure.ts` (what a window does when its document will not
// load), and `./auxiliary-window.ts` (which auxiliary window opens and on
// what). What stays here is construction: the one locked `webPreferences`
// literal, the one document-URL resolution, and the load ordering both
// factories share.
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

import { installNavigationPolicy } from "./navigation.js";
import { RENDERER_INDEX_URL } from "./renderer-scheme.js";
import { loadDocument, type WindowRole } from "./window-load-failure.js";

const PRELOAD_PATH = path.join(import.meta.dirname, "../preload/index.cjs");

/** The pixel size a window opens at. */
export interface LockedWindowOptions {
  readonly width: number;
  readonly height: number;
}

/**
 * The single owner of the locked `webPreferences` block.
 *
 * Every window this process creates is constructed here, so the build-time
 * assertion covers all of them by covering one literal. Keep this the only
 * `new BrowserWindow(...)` call site in the package —
 * `apps/desktop/build/assert-webprefs.ts` fails the build if a second one
 * appears anywhere under `src/main/`, which is what makes exporting this
 * function safe: a neighbour can CALL the locked factory and still cannot
 * declare an unlocked one.
 */
export function constructLockedWindow(options: LockedWindowOptions): BrowserWindow {
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
 * loaded over the renderer scheme. The dev server serves the same
 * Content-Security-Policy the protocol handler does (see
 * `./renderer-scheme.ts` and `electron.vite.config.ts`), so the document's
 * policy does not depend on which branch ran.
 *
 * The two origins differ, so the renderer's browser-storage partition differs
 * between `electron-vite dev` and the built bundle — accepted and stated,
 * because of what is allowed to live there. Per `Spec-023 §Console Design
 * (Meridian)` that store holds UI state only — layouts, selection, pins,
 * expansion — while composer text, form values, paths, and code stay in window
 * memory and are never written to it. So a partition split costs a pane its
 * remembered layout and can never cost a draft, and every console test tier
 * runs the built bundle regardless.
 */
export function resolveRendererDocumentUrl(routeFragment: string): string {
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
export function prepareAndLoad(
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
