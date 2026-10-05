// Main's registry of windows. Every window a person sees is alike and none is the main one: at
// start main builds the hidden console window, which loads the renderer and is kept until quit,
// and that document opens every window a person sees through `window.open`, which main answers by
// building its own window around the handed document. The registry keeps the windows a person sees
// in the order they were last used, the console window used last and each window's kept place
// (read before the console window is built, written whole when one closes, and kept for the
// console windows open now, the last one closed and one place per pane kind), and the app's
// answers to the platform's window events. The hidden window never closes, so Electron's
// `window-all-closed` never fires: the registry counts the windows a person sees, and the last of
// them closing drives the platform's last-window behavior. It also answers a Dock click, a second
// launch and the renderer's process going away, the third loss in a row reloading it as a safe
// start that leaves every kept place as it is, and it carries the `window` subscriptions' pushes to
// the console document, the one document that holds the bridge.

import { randomUUID } from "node:crypto";

import type {
  App,
  BaseWindow,
  RenderProcessGoneDetails,
  Rectangle,
  Screen,
  WebContents,
} from "electron";

import type { AppearanceRecord } from "@shared/appearance.js";
import {
  APPEARANCE_VALUE_CHANNEL,
  FULLSCREEN_VALUE_CHANNEL,
  type FullscreenPush,
} from "@shared/bridge-channels.js";
import { consoleWindowId, isConsoleWindowId } from "@shared/window/frame-name.js";
import { lastUsedWindowIdSwitch } from "@shared/window/window-id.js";
import type { WindowDefaultSizes } from "@shared/window/window-size.js";

import type { KeptAppearance } from "../appearance/kept-appearance.js";
import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import { paneKindOfPlaceKey, placeKeyForFrameName } from "./frame-name.js";
import { newWindowBounds } from "./places/new-window-bounds.js";
import type { WindowPlace, WindowPlaceFile } from "./places/place-file.js";
import { fitOnScreen } from "./places/screen-fit.js";
import { RendererCrashes, type RendererReload } from "./renderer-crashes.js";
import {
  adoptRendererChild,
  openConsoleWindow,
  type ConsoleWindowOptions,
  type RendererWindow,
  type WindowFrame,
} from "./window.js";
import { bringWindowForward } from "./window-reveal.js";

/** What the registry is built over. */
export interface OpenWindowsOptions {
  readonly placeFile: Pick<WindowPlaceFile, "readSync" | "writeSync">;
  readonly screen: Pick<Screen, "getDisplayMatching" | "getPrimaryDisplay">;
  readonly appearance: Pick<KeptAppearance, "ground" | "record" | "subscribe">;
  /** Main's diagnostic log, where a window's failures are recorded. */
  readonly log: Pick<MainDiagnosticLog, "write" | "drain">;
  readonly platform?: NodeJS.Platform;
}

/**
 * How the console window opens at start: its renderer switches, to which the registry adds the
 * window used last, and the caller's load hook.
 */
export type ConsoleWindowStart = Pick<ConsoleWindowOptions, "additionalArguments" | "beforeLoad">;

/** One window a person sees: its id, the frame name it was opened under, and its place key. */
interface OpenWindow {
  readonly windowId: string;
  readonly placeKey: string;
  readonly rendererWindow: RendererWindow;
}

/** The open windows, their focus order and kept places, and the app's window lifecycle. */
export class OpenWindows {
  readonly #placeFile: OpenWindowsOptions["placeFile"];
  readonly #screen: OpenWindowsOptions["screen"];
  readonly #appearance: OpenWindowsOptions["appearance"];
  readonly #log: OpenWindowsOptions["log"];
  readonly #platform: NodeJS.Platform;
  readonly #places: Map<string, WindowPlace>;
  /** The windows a person sees, most recently used first. */
  readonly #windows: OpenWindow[] = [];
  /** Windows whose document is gone or going, closing while a new console document reopens them. */
  readonly #closingWithTheirDocument = new Set<OpenWindow>();
  readonly #crashes = new RendererCrashes();
  /** The hidden console window; `undefined` until start has built it. */
  #console: RendererWindow | undefined;
  /** Start's renderer switches, which every rebuilt console window is started with again. */
  #consoleArguments: readonly string[] | undefined;
  /** The app the lifecycle is installed on, which the last window closing quits off macOS. */
  #app: Pick<App, "on" | "quit"> | undefined;
  /** Set from the renderer's loss until the later task that answers it runs. */
  #isRecoveryPending = false;
  /** Whether the renderer loaded now is a safe start, during which no kept place changes. */
  #isSafeStart = false;
  #pushedRecord: AppearanceRecord;
  /** The window of session views used last; a fresh id on a first launch. */
  #windowUsedLast: string;
  /** Set once a quit begins, so focus moving as the windows close keeps the window used last. */
  #isQuitting = false;
  /** The widths the renderer handed for a window with no kept place; none before it hands them. */
  #defaultSizes: WindowDefaultSizes | undefined;

  /** Reads the kept places, so every window opens where it was. Safe before `ready`. */
  public constructor(options: OpenWindowsOptions) {
    this.#placeFile = options.placeFile;
    this.#screen = options.screen;
    this.#appearance = options.appearance;
    this.#log = options.log;
    this.#platform = options.platform ?? process.platform;
    const kept = this.#placeFile.readSync();
    this.#places = new Map(kept.places);
    this.#windowUsedLast = kept.windowUsedLast ?? consoleWindowId(randomUUID());
    this.#pushedRecord = this.#appearance.record;
    this.#appearance.subscribe(() => {
      this.#paintGrounds();
      this.#pushAppearance();
    });
  }

  /**
   * Builds the hidden console window at start, loading the renderer and handed the window used
   * last, which its document opens first. The registry builds it again after the renderer's
   * process went, and on a Dock click or a second launch once every window a person sees closed.
   */
  public openConsoleWindow(options: ConsoleWindowStart): RendererWindow {
    this.#consoleArguments = options.additionalArguments;
    return this.#buildConsoleWindow(options.beforeLoad);
  }

  /** Whether the renderer loaded now is a safe start, which opens without the kept window layout. */
  public get isSafeStart(): boolean {
    return this.#isSafeStart;
  }

  /**
   * Installs the app's window lifecycle; call it before `ready`, so a second launch that arrives
   * while the app starts is heard. Closing the last window a person sees quits on Windows and
   * Linux and leaves the app running on macOS, where a Dock click opens a window again; a second
   * launch brings the window used last forward. A quit closes the console window first, so its
   * windows close with it rather than one by one as a person would. Before start has built the
   * console window, neither a Dock click nor a second launch opens one: start is about to.
   */
  public installLifecycle(app: Pick<App, "on" | "quit">): void {
    this.#app = app;
    app.on("before-quit", () => {
      if (this.#isQuitting) {
        return;
      }
      this.#isQuitting = true;
      // Every console window open now comes back at the next start, and only those; each one's
      // close writes the file.
      this.#keepOnlyPlacesOf(this.#windows);
      // Already gone when a probe or a crash closed every window before the quit.
      if (this.#console !== undefined && !this.#console.baseWindow.isDestroyed()) {
        this.#console.baseWindow.close();
      }
    });
    // Subscribed so the app's own quit decides: unsubscribed, Electron quits when the console
    // window goes, which a quit already under way does not need asked again.
    app.on("window-all-closed", () => undefined);
    app.on("activate", () => {
      if (this.#windows.length === 0) {
        this.#reopenConsoleWindow();
      }
    });
    app.on("second-instance", () => {
      const lastUsed = this.#windows[0];
      if (lastUsed === undefined) {
        this.#reopenConsoleWindow();
      } else {
        bringWindowForward(lastUsed.rendererWindow.baseWindow, this.#platform);
      }
    });
  }

  /**
   * The window a person sees with `windowId`, the frame name it was opened under, or `undefined`
   * when none is open.
   */
  public windowWithId(windowId: string): BaseWindow | undefined {
    return this.#windows.find((openWindow) => openWindow.windowId === windowId)?.rendererWindow
      .baseWindow;
  }

  /** The window a person used last, or `undefined` when none is open. */
  public windowUsedLast(): BaseWindow | undefined {
    return this.#windows[0]?.rendererWindow.baseWindow;
  }

  /**
   * Takes the widths a window with no kept place opens at, as the renderer sums them; a window it
   * opens before handing any opens as wide as the work area.
   */
  public setDefaultSizes(sizes: WindowDefaultSizes): void {
    this.#defaultSizes = sizes;
  }

  /** Whether `webContents` is the console document, the one document that holds the bridge. */
  public isConsoleDocument(webContents: WebContents): boolean {
    return this.#console !== undefined && this.#console.view.webContents === webContents;
  }

  /**
   * The console window again, with start's switches and the window used last now, its load a safe
   * start or not as `reload` says; nothing before start has built it. The old console window
   * closes once the new one is built.
   */
  #reopenConsoleWindow(reload: RendererReload = "restore"): void {
    if (this.#consoleArguments === undefined) {
      return;
    }
    const previous = this.#console;
    // Set before the build, whose load the console document is served to.
    this.#isSafeStart = reload === "safe-start";
    this.#buildConsoleWindow(undefined);
    previous?.baseWindow.close();
  }

  #buildConsoleWindow(beforeLoad: ConsoleWindowOptions["beforeLoad"]): RendererWindow {
    const consoleWindow = openConsoleWindow({
      background: this.#appearance.ground,
      openChildWindow: this.#openChildWindow,
      log: this.#log,
      additionalArguments: [
        ...(this.#consoleArguments ?? []),
        lastUsedWindowIdSwitch(this.#windowUsedLast),
      ],
      ...(beforeLoad === undefined ? {} : { beforeLoad }),
    });
    this.#console = consoleWindow;
    // Let go of a closed console window, so nothing here keeps its wrapper reachable.
    consoleWindow.baseWindow.once("closed", () => {
      if (this.#console === consoleWindow) {
        this.#console = undefined;
      }
    });
    // One renderer process draws every window, so its loss reaches the console document.
    consoleWindow.view.webContents.on(
      "render-process-gone",
      (_event, details: RenderProcessGoneDetails) => {
        if (this.#console === consoleWindow && !this.#isQuitting && !this.#isRecoveryPending) {
          this.#isRecoveryPending = true;
          // Answered on a later task: a reload started inside this handler re-enters the lost
          // process's start and can crash the main process.
          setTimeout(() => {
            this.#recoverFromRendererLoss(details);
          }, 0);
        }
      },
    );
    // A new console document (a reload, or the failure document) starts with no windows, and
    // reopening one under its old name would load a blank page over it: the windows the old
    // document drew close, their places kept, and the new document reopens them.
    consoleWindow.view.webContents.on("did-start-navigation", (details) => {
      if (this.#console === consoleWindow && details.isMainFrame && !details.isSameDocument) {
        this.#closeWindowsOfReplacedDocument();
      }
    });
    return consoleWindow;
  }

  /** Close every window a person sees, keeping each one's place, for a console document to come. */
  #closeWindowsOfReplacedDocument(): void {
    const drawnByOldDocument = [...this.#windows];
    if (drawnByOldDocument.length === 0) {
      return;
    }
    for (const openWindow of drawnByOldDocument) {
      this.#closingWithTheirDocument.add(openWindow);
      this.#recordPlace(openWindow);
    }
    this.#writePlaces();
    for (const openWindow of drawnByOldDocument) {
      openWindow.rendererWindow.baseWindow.close();
    }
  }

  /** Main's answer to the console document's `window.open` under one frame name. */
  #openChildWindow = (frameName: string): ((handed: WebContents) => WebContents) | undefined => {
    const placeKey = placeKeyForFrameName(frameName);
    if (placeKey === undefined) {
      return undefined;
    }
    return (handedWebContents) => {
      const rendererWindow = adoptRendererChild(this.#frameFor(placeKey), handedWebContents);
      this.#track({ windowId: frameName, placeKey, rendererWindow });
      return rendererWindow.view.webContents;
    };
  };

  /**
   * The frame a window under `placeKey` opens in: its kept place on screen, or, with none, centered
   * or cascaded off the window used last.
   */
  #frameFor(placeKey: string): WindowFrame {
    const place = this.#places.get(placeKey);
    return {
      bounds: place === undefined ? this.#newWindowBounds(placeKey) : this.#onScreen(place),
      reveal: {
        isMaximized: place?.isMaximized ?? false,
        isFullScreen: place?.isFullScreen ?? false,
      },
      background: this.#appearance.ground,
      openChildWindow: this.#openChildWindow,
      log: this.#log,
    };
  }

  #onScreen(bounds: Rectangle): Rectangle {
    return fitOnScreen(bounds, this.#screen.getDisplayMatching(bounds).workArea);
  }

  #newWindowBounds(placeKey: string): Rectangle {
    const openBounds = this.#windows
      .filter((openWindow) => !this.#closingWithTheirDocument.has(openWindow))
      .map((openWindow) => openWindow.rendererWindow.baseWindow.getNormalBounds());
    const previous = openBounds[0];
    const workArea =
      previous === undefined
        ? this.#screen.getPrimaryDisplay().workArea
        : this.#screen.getDisplayMatching(previous).workArea;
    return newWindowBounds(workArea, this.#defaultWidth(placeKey) ?? workArea.width, openBounds);
  }

  /** The width the renderer handed for the kind of window kept under `placeKey`. */
  #defaultWidth(placeKey: string): number | undefined {
    const paneKind = paneKindOfPlaceKey(placeKey);
    return paneKind === undefined
      ? this.#defaultSizes?.consoleWindowWidth
      : this.#defaultSizes?.paneWidths[paneKind];
  }

  #track(openWindow: OpenWindow): void {
    this.#windows.unshift(openWindow);
    const { baseWindow } = openWindow.rendererWindow;
    const { windowId } = openWindow;
    baseWindow.on("focus", () => {
      if (this.#closingWithTheirDocument.has(openWindow)) {
        return;
      }
      this.#moveToFront(openWindow);
      if (isConsoleWindowId(windowId) && !this.#isQuitting) {
        this.#windowUsedLast = windowId;
      }
    });
    baseWindow.on("enter-full-screen", () => {
      this.#sendToConsole(FULLSCREEN_VALUE_CHANNEL, { windowId, isFullScreen: true });
    });
    baseWindow.on("leave-full-screen", () => {
      this.#sendToConsole(FULLSCREEN_VALUE_CHANNEL, { windowId, isFullScreen: false });
    });
    // `close`, not `closed`: the window's rectangle is still readable. A safe start keeps no place.
    baseWindow.on("close", () => {
      if (!this.#closingWithTheirDocument.has(openWindow) && !this.#isSafeStart) {
        this.#keepPlace(openWindow);
      }
    });
    baseWindow.once("closed", () => {
      this.#windows.splice(this.#windows.indexOf(openWindow), 1);
      const isClosingWithTheirDocument = this.#closingWithTheirDocument.delete(openWindow);
      if (this.#windows.length === 0 && !isClosingWithTheirDocument && !this.#isQuitting) {
        this.#closeLastWindow();
      }
    });
  }

  /**
   * The last window a person sees closed: off macOS the app quits; on macOS it keeps running, with
   * its menu bar and menu-bar icon, until a Dock click opens a window again.
   */
  #closeLastWindow(): void {
    if (this.#platform !== "darwin") {
      this.#app?.quit();
    }
  }

  #moveToFront(openWindow: OpenWindow): void {
    this.#windows.splice(this.#windows.indexOf(openWindow), 1);
    this.#windows.unshift(openWindow);
  }

  /**
   * The renderer's process went, taking every window's document with it. The console window is
   * built again, which reloads the renderer, and the windows that lost their documents close,
   * pruning no place. After the first and second loss in a row every window's place is kept as it
   * stands and the reloaded renderer reopens every window from its kept layout, each at the place
   * kept here; after the third the reload is a safe start, which leaves every kept place as it was.
   */
  #recoverFromRendererLoss(details: RenderProcessGoneDetails): void {
    this.#isRecoveryPending = false;
    if (this.#isQuitting) {
      return;
    }
    const reload = this.#crashes.count();
    const lost = [...this.#windows];
    this.#log.write({
      at: new Date().toISOString(),
      level: "error",
      source: "main/windows/open-windows",
      message:
        `the renderer's process is gone (${details.reason}, exit code ` +
        `${String(details.exitCode)}); reopening its ${String(lost.length)} window(s)` +
        (reload === "safe-start" ? " as a safe start, after repeated losses." : "."),
    });
    for (const openWindow of lost) {
      this.#closingWithTheirDocument.add(openWindow);
    }
    if (reload === "restore") {
      for (const openWindow of lost) {
        this.#recordPlace(openWindow);
      }
      this.#writePlaces();
    }
    this.#reopenConsoleWindow(reload);
    this.#crashes.reloaded();
    for (const openWindow of lost) {
      openWindow.rendererWindow.baseWindow.close();
    }
  }

  /**
   * Keeps the closing window's place, and outside a quit keeps the file to the console windows
   * still open, or this one when it is the last, so a Dock click reopens it where it was.
   */
  #keepPlace(closing: OpenWindow): void {
    this.#recordPlace(closing);
    if (!this.#isQuitting) {
      const others = this.#windows.filter((openWindow) => openWindow !== closing);
      this.#keepOnlyPlacesOf(others.length === 0 ? [closing] : others);
      // The most recently used window of session views left is the one opened first from now on.
      const nextUsed = others
        .map((openWindow) => openWindow.windowId)
        .find((windowId) => isConsoleWindowId(windowId));
      if (closing.windowId === this.#windowUsedLast && nextUsed !== undefined) {
        this.#windowUsedLast = nextUsed;
      }
    }
    this.#writePlaces();
  }

  #recordPlace(openWindow: OpenWindow): void {
    const { baseWindow } = openWindow.rendererWindow;
    this.#places.set(openWindow.placeKey, {
      ...baseWindow.getNormalBounds(),
      isMaximized: baseWindow.isMaximized(),
      isFullScreen: baseWindow.isFullScreen(),
    });
  }

  #writePlaces(): void {
    try {
      this.#placeFile.writeSync({ windowUsedLast: this.#windowUsedLast, places: this.#places });
    } catch (error) {
      // A close has no caller to answer; the log is the record, and the window still closes, at
      // its old place next time.
      this.#log.write({
        at: new Date().toISOString(),
        level: "error",
        source: "main/windows/open-windows",
        message: `the window places were not kept: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /** Drops every console window's place but those of `windows`; a pane kind's place stays. */
  #keepOnlyPlacesOf(windows: readonly OpenWindow[]): void {
    const placeKeys = new Set(windows.map((openWindow) => openWindow.placeKey));
    for (const placeKey of this.#places.keys()) {
      if (isConsoleWindowId(placeKey) && !placeKeys.has(placeKey)) {
        this.#places.delete(placeKey);
      }
    }
  }

  /** The record to the console document, once per change of the record itself. */
  #pushAppearance(): void {
    const record = this.#appearance.record;
    if (record === this.#pushedRecord) {
      return;
    }
    this.#pushedRecord = record;
    this.#sendToConsole(APPEARANCE_VALUE_CHANNEL, record);
  }

  #sendToConsole(channel: string, value: AppearanceRecord | FullscreenPush): void {
    const consoleDocument = this.#console?.view.webContents;
    // A quit or a reload destroys the document a moment before its window goes.
    if (consoleDocument !== undefined && !consoleDocument.isDestroyed()) {
      consoleDocument.send(channel, value);
    }
  }

  /** Every open window and its view repainted in the ground the appearance now resolves to. */
  #paintGrounds(): void {
    const ground = this.#appearance.ground;
    const rendererWindows = [
      ...(this.#console === undefined ? [] : [this.#console]),
      ...this.#windows.map((openWindow) => openWindow.rendererWindow),
    ];
    for (const { baseWindow, view } of rendererWindows) {
      baseWindow.setBackgroundColor(ground);
      view.setBackgroundColor(ground);
    }
  }
}
