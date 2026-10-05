// Window construction for the main process. Every window is a `BaseWindow` hosting the renderer
// in a `WebContentsView`, and `constructLockedWindow` owns the one `webPreferences` literal; ESLint
// refuses a window or view built anywhere else under `src/main/` and a security setting written as
// anything but its hardened literal.
//
// Two kinds of window come out of it. The first window loads the renderer document, with the
// preload. Every further one adopts the `webContents` Chromium made for the renderer's own
// `window.open`, which keeps the renderer's sandbox, context isolation and CSP and carries no
// preload of its own: one renderer draws into every window.
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
import { RENDERER_INDEX_URL } from "../services/renderer-scheme.js";
import { devServerUrl, installNavigationPolicy, type ChildWindowOpener } from "./navigation.js";
import { loadDocument } from "./window-load-failure.js";
import { applyRevealPreferences, revealWindow, type RevealState } from "./window-reveal.js";

const PRELOAD_PATH = path.join(import.meta.dirname, "../preload/index.cjs");

/** One window: the native window and the view its console document is shown in. */
export interface RendererWindow {
  readonly baseWindow: BaseWindow;
  readonly view: WebContentsView;
}

/** Where a window opens and what it is painted with before its document draws. */
export interface WindowFrame {
  readonly bounds: Rectangle;
  readonly reveal: RevealState;
  /** The kept ground the first frame is painted in, `#rrggbb`. */
  readonly background: string;
  /** Answers the renderer's own `window.open` from this window. */
  readonly openChildWindow: ChildWindowOpener;
  /** Main's diagnostic log, where the window's refusals and failures are recorded. */
  readonly log: Pick<MainDiagnosticLog, "write" | "drain">;
}

/** How a window is built: its frame, and either its renderer switches or a document to adopt. */
interface LockedWindowOptions extends WindowFrame {
  /** Appended to the renderer's command line, where the preload reads them. */
  readonly additionalArguments: readonly string[];
  readonly adoptedWebContents: WebContents | undefined;
}

/**
 * The single owner of the locked `webPreferences` block, and the only `new BaseWindow(...)` and
 * `new WebContentsView(...)` call site under `src/main/`; ESLint refuses a second one. An adopted
 * `webContents` keeps the preferences it was made with, which Chromium copied from its opener's.
 */
function constructLockedWindow(options: LockedWindowOptions): RendererWindow {
  const baseWindow = new BaseWindow({
    ...options.bounds,
    show: false,
    // On macOS the console fills the window under the traffic lights; elsewhere the system's
    // own title strip stays.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: options.background,
  });
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
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
 * The document the first window loads: the dev server under `electron-vite dev`, so hot reload
 * works, and otherwise the built bundle over the renderer scheme. The two origins have separate
 * browser-storage partitions; that store holds UI state only, so a split can cost a pane its
 * layout and never a draft.
 */
function resolveRendererDocumentUrl(): string {
  return devServerUrl()?.href ?? RENDERER_INDEX_URL;
}

/** How the first window opens: its frame, its renderer switches, and the caller's load hook. */
export interface RendererWindowOptions extends WindowFrame {
  /**
   * Renderer switches for this window: the app's facts, and on a fixture launch its scenario
   * (`@shared/fixture-launch.ts`).
   */
  readonly additionalArguments: readonly string[];
  /**
   * Runs with the constructed window as the last act before the load, so a listener for
   * `did-finish-load`, `did-fail-load` or `dom-ready` registered inside it cannot be late. A throw
   * destroys the window rather than leaving a blank one behind, and is rethrown.
   */
  readonly beforeLoad?: (rendererWindow: RendererWindow) => void;
}

/** Builds a window that loads the renderer document, revealed once that document has loaded. */
export function openRendererWindow(options: RendererWindowOptions): RendererWindow {
  const rendererWindow = constructLockedWindow({ ...options, adoptedWebContents: undefined });
  const { baseWindow, view } = rendererWindow;
  view.webContents.once("did-finish-load", () => {
    revealWindow(baseWindow, options.reveal);
  });

  try {
    options.beforeLoad?.(rendererWindow);
  } catch (error: unknown) {
    if (!baseWindow.isDestroyed()) {
      baseWindow.destroy();
    }
    throw error;
  }

  loadDocument(baseWindow, view.webContents, resolveRendererDocumentUrl(), options.log);
  return rendererWindow;
}

/**
 * Builds a window around the `webContents` Chromium made for the renderer's `window.open`, and
 * reveals it at once: the renderer that opened it draws its document, so there is no load to wait
 * for.
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
