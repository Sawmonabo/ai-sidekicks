// `BrowserWindow` factories for the main process. One private function,
// `constructLockedWindow`, owns the `webPreferences` literal, so the build-time assertion
// (`apps/desktop/build/assert-webprefs.ts`) covers every window through one block and requires
// that block to appear exactly once. Any drift fails `pnpm build`, which makes
// `nodeIntegration: true` or `sandbox: false` a build error rather than a shipped one.
//
// The window is served over `sidekicks-renderer://`, never `file://`, because the hardening
// baseline disables the `GrantFileProtocolExtraPrivileges` fuse (`../services/renderer-protocol.ts`
// registers the scheme). Navigation policy lives in `./navigation.ts` and load recovery in
// `./window-load-failure.ts`; this file is construction, the document-URL resolution, and the
// load ordering.
//
// The preload path uses `import.meta.dirname`, not a `__dirname` reconstruction: electron-vite's
// `esmShim` plugin injects `const __filename`/`__dirname` into ESM bundles when it sees those
// tokens in user code, and a second declaration in this file collides with it as
// `SyntaxError: Identifier '__filename' has already been declared` at boot (verified
// empirically).
//
// The preload is `.cjs`, not `.js`: Electron's sandboxed preload runtime (`sandbox: true`
// below) supports only CommonJS (verified on Electron 41.6.1 and the 44.x pin; an ESM preload
// fails with `SyntaxError: Cannot use import statement outside a module`), and the extension
// overrides the package's `"type": "module"`.

import { app, BrowserWindow } from "electron";
import path from "node:path";

import { installNavigationPolicy } from "./navigation.js";
import { RENDERER_INDEX_URL } from "../services/renderer-scheme.js";
import { loadDocument } from "./window-load-failure.js";
import { applyRevealPreferences, revealWindow } from "./window-reveal.js";

const PRELOAD_PATH = path.join(import.meta.dirname, "../preload/index.cjs");

/** The pixel size a window opens at, and the switches its renderer starts with. */
export interface LockedWindowOptions {
  readonly width: number;
  readonly height: number;
  /** Appended to the renderer's command line, where the preload reads them. */
  readonly additionalArguments: readonly string[];
}

/**
 * The single owner of the locked `webPreferences` block. Keep this the only
 * `new BrowserWindow(...)` call site under `src/main/`: `apps/desktop/build/assert-webprefs.ts`
 * fails the build if a second one appears.
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
      additionalArguments: [...options.additionalArguments],
    },
  });

  installNavigationPolicy(browserWindow);
  applyRevealPreferences(browserWindow);

  // Delegated so every window takes the same reveal decision (`./window-reveal.ts`).
  browserWindow.once("ready-to-show", () => {
    revealWindow(browserWindow);
  });

  return browserWindow;
}

/**
 * Resolves the document URL a window loads. Under `electron-vite dev` the dev server is loaded
 * so HMR works; in a packaged app, or with no dev server running, the built bundle is loaded
 * over the renderer scheme. `./navigation.ts` reads the same variable for the allowed origins.
 * The dev server serves the same Content-Security-Policy as the protocol handler
 * (`../services/renderer-scheme.ts`, `electron.vite.config.ts`).
 *
 * The two origins have different browser-storage partitions. That store holds UI state only
 * (layouts, selection, pins, expansion); composer text, form values, paths and code stay in
 * window memory, so a partition split can cost a pane its layout and never a draft.
 */
function resolveRendererDocumentUrl(): string {
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devServerUrl !== undefined && devServerUrl !== "") {
    return devServerUrl;
  }
  return RENDERER_INDEX_URL;
}

/**
 * How a caller attaches to a window before its load begins. `beforeLoad` runs with the
 * constructed window as the last act before `loadURL`, so a listener for `did-finish-load`,
 * `did-fail-load` or `dom-ready` registered inside it cannot be late. One call that cannot be
 * mis-sequenced beats handing back an unloaded window, which would allow load-first and
 * forgot-to-load. A throw from `beforeLoad` destroys the window rather than leaving a blank
 * one behind.
 */
export interface WindowLoadOptions {
  readonly beforeLoad?: (browserWindow: BrowserWindow) => void;
}

/** Runs the caller's pre-load hook, then starts the load, so the ordering lives in one place. */
function prepareAndLoad(
  browserWindow: BrowserWindow,
  documentUrl: string,
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

  loadDocument(browserWindow, documentUrl);
}

/** How the main window opens, beyond the load hook every window shares. */
export interface MainWindowOptions extends WindowLoadOptions {
  /**
   * Renderer switches for this window. Empty for a normal launch; a fixture launch names
   * its scenario here (`@shared/fixture-launch.ts`).
   */
  readonly additionalArguments?: readonly string[];
}

/** The main session window. */
export function createMainWindow(options: MainWindowOptions = {}): BrowserWindow {
  const browserWindow = constructLockedWindow({
    width: 1280,
    height: 800,
    additionalArguments: options.additionalArguments ?? [],
  });

  prepareAndLoad(browserWindow, resolveRendererDocumentUrl(), options);

  return browserWindow;
}
