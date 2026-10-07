// Window construction for the main process. Every window is a `BaseWindow` hosting the renderer
// in a `WebContentsView`, and `constructLockedWindow` owns the one `webPreferences` literal; ESLint
// refuses a window or view built anywhere else under `src/main/` and a security setting written as
// anything but its hardened literal.
//
// Two kinds of window come out of it. The hidden window loads the renderer's console document, with
// the preload, and is never shown: one renderer drives every window from it. Every window a person
// sees adopts the `webContents` Chromium made for that document's own `window.open`, which keeps
// the renderer's sandbox, context isolation and CSP and carries no preload of its own.
//
// The window is served over `sidekicks-renderer://`, never `file://`, because the hardening
// baseline disables the `GrantFileProtocolExtraPrivileges` fuse. The preload path uses
// `import.meta.dirname`: a `__dirname` of our own collides at boot with the one electron-vite's
// ESM shim injects. The preload is `.cjs`, overriding the package's `"type": "module"`, because
// Electron's sandboxed preload runs only CommonJS; an ESM preload fails with `Cannot use import
// statement outside a module`.

import { BaseWindow, WebContentsView, type Rectangle, type WebContents } from "electron";
import path from "node:path";

import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import { RENDERER_INDEX_URL } from "../services/renderer/scheme.js";
import { devServerUrl, installNavigationPolicy, type ChildWindowOpener } from "./navigation.js";
import { loadDocument } from "./load-failure/recovery.js";
import { applyRevealPreferences, revealWindow, type RevealState } from "./reveal.js";

const PRELOAD_PATH = path.join(import.meta.dirname, "../preload/index.cjs");

/** One window: the native window and the view its document is shown in. */
export interface RendererWindow {
  readonly baseWindow: BaseWindow;
  readonly view: WebContentsView;
}

/** The options every window shares: its background, its answer to `window.open`, and the log. */
export interface SharedWindowOptions {
  /** The kept ground the first frame is painted in, `#rrggbb`. */
  readonly background: string;
  /** Answers the renderer's own `window.open` from this window's document. */
  readonly openChildWindow: ChildWindowOpener;
  /** Main's diagnostic log, where the window's refusals and failures are recorded. */
  readonly log: Pick<MainDiagnosticLog, "write" | "drain" | "lastWriteFailure">;
}

/** Where a window a person sees opens, the state it is revealed into, and its shared options. */
export interface WindowFrame extends SharedWindowOptions {
  readonly bounds: Rectangle;
  readonly reveal: RevealState;
}

/** How a window is built: its rectangle, shared options, and switches or a document to adopt. */
interface LockedWindowOptions extends SharedWindowOptions {
  readonly bounds: Rectangle;
  /** Appended to the renderer's command line, where the preload reads them. */
  readonly additionalArguments: readonly string[];
  readonly adoptedWebContents: WebContents | undefined;
}

/**
 * The hidden window's rectangle. It is never shown, so the size only gives the document a
 * viewport; every window a person sees has its own place.
 */
const HIDDEN_WINDOW_BOUNDS: Rectangle = { x: 0, y: 0, width: 800, height: 600 };

/** The state the hidden window is revealed into when it shows its load-failure document. */
const FAILURE_REVEAL: RevealState = { isMaximized: false, isFullScreen: false };

/**
 * The single owner of the locked `webPreferences` block, and the only `new BaseWindow(...)` and
 * `new WebContentsView(...)` call site under `src/main/`; ESLint refuses a second one. An adopted
 * `webContents` keeps the preferences it was made with: Chromium copied its opener's security
 * settings, and Electron left its developer tools on whatever its opener's setting.
 */
function constructLockedWindow(options: LockedWindowOptions): RendererWindow {
  const baseWindow = new BaseWindow({
    ...options.bounds,
    show: false,
    // On macOS the console fills the window under the traffic lights, and the overlay hands the
    // document their area as `env(titlebar-area-*)`, which is empty in fullscreen, so the rail's
    // width and top inset follow the buttons. Elsewhere the system's own title strip stays.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", titleBarOverlay: true }
      : { titleBarStyle: "default" }),
    backgroundColor: options.background,
  });
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      // Vite's development flag, a literal in the bundle: outside a development build this
      // document has no developer tools to open.
      devTools: import.meta.env.DEV,
      preload: PRELOAD_PATH,
      additionalArguments: [...options.additionalArguments],
    },
    ...(options.adoptedWebContents === undefined
      ? {}
      : { webContents: options.adoptedWebContents }),
  });
  view.setBackgroundColor(options.background);
  baseWindow.contentView.addChildView(view);
  fitViewToWindow(baseWindow, view);
  baseWindow.on("resize", () => {
    fitViewToWindow(baseWindow, view);
  });

  const webContents = view.webContents;
  installNavigationPolicy(webContents, options.openChildWindow, options.log);
  applyRevealPreferences(webContents);
  pairCloses(baseWindow, webContents);
  webContents.on("page-title-updated", (_event, title: string) => {
    baseWindow.setTitle(title);
  });

  return { baseWindow, view };
}

/** The view fills the window's content area; `WebContentsView` does not size itself. */
function fitViewToWindow(baseWindow: BaseWindow, view: WebContentsView): void {
  const contentBounds = baseWindow.getContentBounds();
  view.setBounds({ x: 0, y: 0, width: contentBounds.width, height: contentBounds.height });
}

/**
 * Closing either half closes the other. A `BaseWindow` leaves its views' `webContents` alive when
 * it closes, and a page's own `window.close()` destroys the `webContents` and leaves its window.
 */
function pairCloses(baseWindow: BaseWindow, webContents: WebContents): void {
  baseWindow.once("closed", () => {
    if (!webContents.isDestroyed()) {
      webContents.close();
    }
  });
  webContents.once("destroyed", () => {
    if (!baseWindow.isDestroyed()) {
      baseWindow.close();
    }
  });
}

/**
 * The document the hidden window loads: the dev server under `electron-vite dev`, so hot reload
 * works, and otherwise the built bundle over the renderer scheme. The two origins have separate
 * browser-storage partitions; that store holds UI state only, so a split can cost a window its
 * layout and never a draft.
 */
function resolveRendererDocumentUrl(): string {
  return devServerUrl()?.href ?? RENDERER_INDEX_URL;
}

/** How the hidden window is built: its ground, its renderer switches and the caller's load hook. */
export interface HiddenWindowOptions extends SharedWindowOptions {
  /**
   * The renderer switches: the app's facts, the console window used last, and on a fixture launch
   * its scenario (`#shared/fixture-launch.ts`).
   */
  readonly additionalArguments: readonly string[];
  /**
   * Runs with the constructed window as the last act before the load, so a listener for
   * `did-finish-load`, `did-fail-load` or `dom-ready` registered inside it cannot be late. A throw
   * destroys the window rather than leaving one with no document behind, and is rethrown.
   */
  readonly beforeLoad?: (hiddenWindow: RendererWindow) => void;
}

/**
 * Builds the hidden window, which loads the console document and is never shown. Its
 * background throttling is off, because every window a person sees is drawn by its document's
 * script and timers. It is shown only when its document will not load and it shows the
 * load-failure document instead, so the failure is seen.
 */
export function openHiddenWindow(options: HiddenWindowOptions): RendererWindow {
  const hiddenWindow = constructLockedWindow({
    ...options,
    bounds: HIDDEN_WINDOW_BOUNDS,
    adoptedWebContents: undefined,
  });
  const { baseWindow, view } = hiddenWindow;
  view.webContents.setBackgroundThrottling(false);

  try {
    options.beforeLoad?.(hiddenWindow);
  } catch (error: unknown) {
    if (!baseWindow.isDestroyed()) {
      baseWindow.destroy();
    }
    throw error;
  }

  loadDocument(baseWindow, view.webContents, resolveRendererDocumentUrl(), options.log, () => {
    revealWindow(baseWindow, FAILURE_REVEAL);
  });
  return hiddenWindow;
}

/**
 * Builds a window a person sees around the `webContents` Chromium made for the console document's
 * `window.open`, and reveals it at once: the console document draws into it, so there is no load
 * to wait for.
 */
export function adoptRendererChild(
  frame: WindowFrame,
  handedWebContents: WebContents,
): RendererWindow {
  const rendererWindow = constructLockedWindow({
    ...frame,
    additionalArguments: [],
    adoptedWebContents: handedWebContents,
  });
  revealWindow(rendererWindow.baseWindow, frame.reveal);
  return rendererWindow;
}
