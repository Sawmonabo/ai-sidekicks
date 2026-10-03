// Window construction for the main process. `constructLockedWindow` owns the one
// `webPreferences` literal; ESLint refuses a window built anywhere else under `src/main/` and a
// security setting written as anything but its hardened literal.
//
// The window is served over `sidekicks-renderer://`, never `file://`, because the hardening
// baseline disables the `GrantFileProtocolExtraPrivileges` fuse. The preload path uses
// `import.meta.dirname`: a `__dirname` of our own collides at boot with the one electron-vite's
// ESM shim injects. The preload is `.cjs`, overriding the package's `"type": "module"`, because
// Electron's sandboxed preload runs only CommonJS; an ESM preload fails with `Cannot use import
// statement outside a module`.

import { BrowserWindow } from "electron";
import path from "node:path";

import { devServerUrl, installNavigationPolicy } from "./navigation.js";
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
 * The single owner of the locked `webPreferences` block, and the only `new BrowserWindow(...)`
 * call site under `src/main/`; ESLint refuses a second one.
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
 * The document a window loads: the dev server under `electron-vite dev`, so hot reload works,
 * and otherwise the built bundle over the renderer scheme. The two origins have separate
 * browser-storage partitions; that store holds UI state only, so a split can cost a pane its
 * layout and never a draft.
 */
function resolveRendererDocumentUrl(): string {
  return devServerUrl()?.href ?? RENDERER_INDEX_URL;
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
