// Main's registry of windows. Every window a person sees is alike and none is the main one: at
// start main builds the hidden window, which loads the renderer's console document and is kept
// until quit, and that document opens every window a person sees through `window.open`, which main
// answers by building its own window around the handed document. The registry keeps the windows a
// person sees in the order they were last used, the console window (a window of session views)
// used last and each window's kept place (read before the hidden window is built, written whole
// when one closes, and kept for the console windows open now, the last one closed and one place per
// pane kind), and the app's answers to the platform's window events. The hidden window never
// closes, so Electron's `window-all-closed` never fires: the registry counts the windows a person
// sees, and the last of them closing drives the platform's last-window behavior. A Dock click or a
// second launch with none open asks the console document to reopen the console window used last;
// the renderer's process going away builds the hidden window again, the third loss in a row as a
// safe start that leaves every kept place as it is until the console document ends it. The
// registry carries the `window` pushes to the console document, the one document with the bridge.

import { randomUUID } from "node:crypto";

import type {
  App,
  BaseWindow,
  RenderProcessGoneDetails,
  Rectangle,
  Screen,
  WebContents,
} from "electron";

import type { AppearanceRecord } from "#shared/appearance.js";
import {
  APPEARANCE_VALUE_CHANNEL,
  REOPEN_WINDOW_CHANNEL,
  UNKEPT_SCHEME_CHANNEL,
} from "#shared/bridge-channels.js";
import { consoleWindowId, isConsoleWindowId } from "#shared/window/frame-name.js";
import { lastUsedWindowIdSwitch } from "#shared/window/last-used.js";
import type { WindowDefaultSizes } from "#shared/window/size.js";

import type { KeptAppearance } from "../appearance/kept-record.js";
import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import { describeFailure } from "../services/failure-message.js";
import { paneKindOfPlaceKey, placeKeyForFrameName } from "./places/key.js";
import { newWindowBounds } from "./places/new-bounds.js";
import type { WindowPlace, WindowPlaceFile } from "./places/file.js";
import { fitOnScreen } from "./places/screen-fit.js";
import { RendererCrashes, type RendererReload } from "./renderer-crashes.js";
import {
  adoptRendererChild,
  openHiddenWindow,
  type HiddenWindowOptions,
  type RendererWindow,
  type WindowFrame,
} from "./factory.js";
import { bringWindowForward } from "./reveal.js";

/** What the registry is built over. */
export interface OpenWindowsOptions {
  readonly placeFile: Pick<WindowPlaceFile, "readSync" | "writeSync">;
  readonly screen: Pick<Screen, "getDisplayMatching" | "getPrimaryDisplay">;
  readonly appearance: Pick<KeptAppearance, "ground" | "record" | "subscribe">;
  /** Main's diagnostic log, where a window's failures are recorded. */
  readonly log: Pick<MainDiagnosticLog, "write" | "drain" | "lastWriteFailure">;
  readonly platform?: NodeJS.Platform;
}

/**
 * How the hidden window opens at start: its renderer switches, to which the registry adds the
 * console window used last, and the caller's load hook.
 */
export type HiddenWindowStart = Pick<HiddenWindowOptions, "additionalArguments" | "beforeLoad">;

/**
 * One window a person sees: its id (the frame name it was opened under), its place key and its
 * window.
 */
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
  /** The hidden window, which holds the console document; `undefined` until start has built it. */
  #hiddenWindow: RendererWindow | undefined;
  /** Start's renderer switches, which every rebuilt hidden window is started with again. */
  #hiddenWindowArguments: readonly string[] | undefined;
  /** The app the lifecycle is installed on, which the last window closing quits off macOS. */
  #app: Pick<App, "on" | "quit"> | undefined;
  /** Set from the renderer's loss until the later task that answers it runs. */
  #isRecoveryPending = false;
  /** Whether the renderer loaded now is a safe start, during which no kept place changes. */
  #isSafeStart = false;
  #pushedRecord: AppearanceRecord;
  /** The id of the console window used last; a fresh one on a first launch. */
  #consoleWindowUsedLast: string;
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
    this.#consoleWindowUsedLast = kept.windowUsedLast ?? consoleWindowId(randomUUID());
    this.#pushedRecord = this.#appearance.record;
    this.#appearance.subscribe(() => {
      this.#paintGrounds();
      this.#pushAppearance();
    });
  }

  /**
   * Builds the hidden window at start, loading the console document handed the console window used
   * last, which it opens first. The registry builds it again after the renderer's process went,
   * and on a Dock click or a second launch once a person closed it showing the load-failure page.
   */
  public openHiddenWindow(options: HiddenWindowStart): RendererWindow {
    this.#hiddenWindowArguments = options.additionalArguments;
    return this.#buildHiddenWindow(options.beforeLoad);
  }

  /** Whether the renderer loaded now is a safe start, opened without the kept window layout. */
  public get isSafeStart(): boolean {
    return this.#isSafeStart;
  }

  /** Ends the safe start once the console document restored the kept windows: places keep again. */
  public endSafeStart(): void {
    this.#isSafeStart = false;
  }

  /**
   * Installs the app's window lifecycle; call it before `ready`, so a second launch that arrives
   * while the app starts is heard. Closing the last window a person sees quits on Windows and
   * Linux and leaves the app running on macOS, where a Dock click opens a window again; a second
   * launch brings the window used last forward. A quit closes the hidden window first and the
   * windows a person sees once its document is gone, so the console document never hears them
   * close one by one as a person would close them. During a quit, and before start has built the
   * hidden window, neither a Dock click nor a second launch opens a window.
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
      const hiddenWindow = this.#hiddenWindow;
      // Already gone when a probe or a crash closed every window before the quit.
      if (hiddenWindow === undefined || hiddenWindow.baseWindow.isDestroyed()) {
        this.#closeEveryWindow();
        return;
      }
      hiddenWindow.view.webContents.once("destroyed", () => {
        this.#closeEveryWindow();
      });
      hiddenWindow.baseWindow.close();
    });
    // Subscribed so the app's own quit decides: unsubscribed, Electron quits when the hidden
    // window goes, which a quit already under way does not need asked again.
    app.on("window-all-closed", () => undefined);
    app.on("activate", () => {
      if (!this.#isQuitting && this.#windows.length === 0) {
        this.#reopenWindowUsedLast();
      }
    });
    app.on("second-instance", () => {
      if (this.#isQuitting) {
        return;
      }
      const lastUsed = this.#windows[0];
      if (lastUsed === undefined) {
        this.#reopenWindowUsedLast();
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
   * Takes the widths a pane's own window with no kept place opens at, as the renderer reads them;
   * one it opens before handing any opens as wide as the work area.
   */
  public setDefaultSizes(sizes: WindowDefaultSizes): void {
    this.#defaultSizes = sizes;
  }

  /**
   * Tells the console document that a color scheme picked from the View menu was not saved, so
   * the window used last says so on its banner.
   */
  public announceUnkeptScheme(): void {
    this.#sendToConsoleDocument(UNKEPT_SCHEME_CHANNEL, undefined);
  }

  /** Whether `webContents` is the console document, the one document that holds the bridge. */
  public isConsoleDocument(webContents: WebContents): boolean {
    return this.#hiddenWindow !== undefined && this.#hiddenWindow.view.webContents === webContents;
  }

  /**
   * A Dock click or a second launch with no window a person sees: the console document, kept since
   * start, opens the console window used last again. The hidden window is built again only when a
   * person closed it, and when it shows the load-failure page that page comes forward instead.
   */
  #reopenWindowUsedLast(): void {
    const hiddenWindow = this.#hiddenWindow;
    if (hiddenWindow === undefined) {
      this.#rebuildHiddenWindow();
    } else if (hiddenWindow.baseWindow.isVisible()) {
      bringWindowForward(hiddenWindow.baseWindow, this.#platform);
    } else {
      this.#sendToConsoleDocument(REOPEN_WINDOW_CHANNEL, this.#consoleWindowUsedLast);
    }
  }

  /**
   * The hidden window again, with start's switches and the console window used last now, its load
   * a safe start or not as `reload` says; nothing before start has built it. The old hidden window
   * closes once the new one is built.
   */
  #rebuildHiddenWindow(reload: RendererReload = "restore"): void {
    if (this.#hiddenWindowArguments === undefined) {
      return;
    }
    const previous = this.#hiddenWindow;
    // Set before the build, whose load the console document is served to.
    this.#isSafeStart = reload === "safe-start";
    this.#buildHiddenWindow(undefined);
    previous?.baseWindow.close();
  }

  #buildHiddenWindow(beforeLoad: HiddenWindowOptions["beforeLoad"]): RendererWindow {
    const hiddenWindow = openHiddenWindow({
      background: this.#appearance.ground,
      openChildWindow: this.#openChildWindow,
      log: this.#log,
      additionalArguments: [
        ...(this.#hiddenWindowArguments ?? []),
        lastUsedWindowIdSwitch(this.#consoleWindowUsedLast),
      ],
      ...(beforeLoad === undefined ? {} : { beforeLoad }),
    });
    this.#hiddenWindow = hiddenWindow;
    // Only a person closes the hidden window still in use, when it shows the load-failure page;
    // `destroy`, which gives up on a page that cannot be served, emits no `close`.
    let isClosedByPerson = false;
    hiddenWindow.baseWindow.once("close", () => {
      isClosedByPerson = this.#hiddenWindow === hiddenWindow && !this.#isQuitting;
    });
    hiddenWindow.baseWindow.once("closed", () => {
      if (this.#hiddenWindow !== hiddenWindow) {
        return;
      }
      // Let go of it, so nothing here keeps its wrapper reachable.
      this.#hiddenWindow = undefined;
      if (isClosedByPerson && this.#windows.length === 0) {
        this.#closeLastWindow();
      }
    });
    // One renderer process draws every window, so its loss reaches the console document.
    hiddenWindow.view.webContents.on(
      "render-process-gone",
      (_event, details: RenderProcessGoneDetails) => {
        if (this.#hiddenWindow === hiddenWindow && !this.#isQuitting && !this.#isRecoveryPending) {
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
    hiddenWindow.view.webContents.on("did-start-navigation", (details) => {
      if (this.#hiddenWindow === hiddenWindow && details.isMainFrame && !details.isSameDocument) {
        this.#closeWindowsOfReplacedDocument();
      }
    });
    return hiddenWindow;
  }

  /**
   * Close every window a person sees that is not already closing, keeping each one's place for a
   * console document to come; a safe start keeps no place.
   */
  #closeWindowsOfReplacedDocument(): void {
    const drawnByOldDocument = this.#windows.filter(
      (openWindow) => !this.#closingWithTheirDocument.has(openWindow),
    );
    if (drawnByOldDocument.length === 0) {
      return;
    }
    for (const openWindow of drawnByOldDocument) {
      this.#closingWithTheirDocument.add(openWindow);
      if (!this.#isSafeStart) {
        this.#recordPlace(openWindow);
      }
    }
    if (!this.#isSafeStart) {
      this.#writePlaces();
    }
    for (const openWindow of drawnByOldDocument) {
      openWindow.rendererWindow.baseWindow.close();
    }
  }

  /** At a quit, closes every window a person sees that is still open. */
  #closeEveryWindow(): void {
    for (const openWindow of [...this.#windows]) {
      if (!openWindow.rendererWindow.baseWindow.isDestroyed()) {
        openWindow.rendererWindow.baseWindow.close();
      }
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
    const paneKind = paneKindOfPlaceKey(placeKey);
    return newWindowBounds(
      workArea,
      paneKind === undefined
        ? { kind: "session-views" }
        : { kind: "pane", width: this.#defaultSizes?.paneWidths[paneKind] },
      openBounds,
    );
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
        this.#consoleWindowUsedLast = windowId;
      }
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
   * its menu bar, until a Dock click or a second launch opens a window again.
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
   * The renderer's process went, taking every window's document with it. The hidden window is
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
      level: "error",
      source: "main/windows/registry",
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
    this.#rebuildHiddenWindow(reload);
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
      if (closing.windowId === this.#consoleWindowUsedLast && nextUsed !== undefined) {
        this.#consoleWindowUsedLast = nextUsed;
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
      this.#placeFile.writeSync({
        windowUsedLast: this.#consoleWindowUsedLast,
        places: this.#places,
      });
    } catch (error) {
      // A close has no caller to answer; the log is the record, and the window still closes, at
      // its old place next time.
      this.#log.write({
        level: "error",
        source: "main/windows/registry",
        message: `the window places were not kept: ${describeFailure(error)}`,
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
    this.#sendToConsoleDocument(APPEARANCE_VALUE_CHANNEL, record);
  }

  #sendToConsoleDocument(channel: string, value: unknown): void {
    const consoleDocument = this.#hiddenWindow?.view.webContents;
    // A quit or a reload destroys the document a moment before its window goes.
    if (consoleDocument !== undefined && !consoleDocument.isDestroyed()) {
      consoleDocument.send(channel, value);
    }
  }

  /** Every open window and its view repainted in the ground the appearance now resolves to. */
  #paintGrounds(): void {
    const ground = this.#appearance.ground;
    const rendererWindows = [
      ...(this.#hiddenWindow === undefined ? [] : [this.#hiddenWindow]),
      ...this.#windows.map((openWindow) => openWindow.rendererWindow),
    ];
    for (const { baseWindow, view } of rendererWindows) {
      baseWindow.setBackgroundColor(ground);
      view.setBackgroundColor(ground);
    }
  }
}
