// Main's registry of open windows. Every window is alike and none is the main one: at start main
// builds the console window used last, which loads the renderer, and the renderer opens every
// further one through `window.open`, which main answers by building its own window around the
// handed document. The registry keeps the windows in the order they were last used, the console
// window used last and each window's kept place (read before the first window is built, written
// whole when one closes, and kept for the console windows open now, the last one closed and one
// place per pane kind), and the app's answers to the platform's window events: the last window
// closing, a Dock click, a second launch and the renderer's process going away, the third loss in
// a row reloading it as a safe start that leaves every kept place as it is. It carries the
// `window` subscriptions' pushes to the documents that hold the bridge, the ones that loaded the
// renderer: a `window.open` child has no preload, and the renderer draws into it itself.

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
import { APPEARANCE_VALUE_CHANNEL, FULLSCREEN_VALUE_CHANNEL } from "@shared/bridge-channels.js";
import { windowIdSwitch } from "@shared/window/window-id.js";

import type { KeptAppearance } from "../appearance/kept-appearance.js";
import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import { consoleWindowPlaceKey, placeKeyForFrameName, windowIdOfPlaceKey } from "./frame-name.js";
import { newWindowBounds } from "./places/new-window-bounds.js";
import type { WindowPlace, WindowPlaceFile } from "./places/place-file.js";
import { fitOnScreen } from "./places/screen-fit.js";
import { RendererCrashes, type RendererReload } from "./renderer-crashes.js";
import {
  adoptRendererChild,
  openRendererWindow,
  type RendererWindow,
  type RendererWindowOptions,
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

/** How the first window at start opens: its renderer switches and the caller's load hook. */
export type FirstWindowOptions = Pick<RendererWindowOptions, "additionalArguments" | "beforeLoad">;

/** One open window, the key its place is kept under, and whether its document holds the bridge. */
interface OpenWindow {
  readonly placeKey: string;
  readonly rendererWindow: RendererWindow;
  readonly holdsBridge: boolean;
}

/** The open windows, their focus order and kept places, and the app's window lifecycle. */
export class OpenWindows {
  readonly #placeFile: OpenWindowsOptions["placeFile"];
  readonly #screen: OpenWindowsOptions["screen"];
  readonly #appearance: OpenWindowsOptions["appearance"];
  readonly #log: OpenWindowsOptions["log"];
  readonly #platform: NodeJS.Platform;
  readonly #places: Map<string, WindowPlace>;
  /** Most recently used first. */
  readonly #windows: OpenWindow[] = [];
  /** Windows whose renderer is gone, closing while the reloaded renderer takes their place. */
  readonly #closingAfterCrash = new Set<OpenWindow>();
  readonly #crashes = new RendererCrashes();
  /** Set from the renderer's loss until the later task that answers it runs. */
  #isRecoveryPending = false;
  /** Whether the renderer loaded now is a safe start, during which no kept place changes. */
  #isSafeStart = false;
  /** The first window's renderer switches; `undefined` until start has built it. */
  #firstWindowArguments: readonly string[] | undefined;
  #pushedRecord: AppearanceRecord;
  /** The console window used last; a fresh id on a first launch. */
  #windowUsedLast: string;
  /** Set once a quit begins, so focus moving as the windows close keeps the window used last. */
  #isQuitting = false;

  /** Reads the kept places, so every window opens where it was. Safe before `ready`. */
  public constructor(options: OpenWindowsOptions) {
    this.#placeFile = options.placeFile;
    this.#screen = options.screen;
    this.#appearance = options.appearance;
    this.#log = options.log;
    this.#platform = options.platform ?? process.platform;
    const kept = this.#placeFile.readSync();
    this.#places = new Map(kept.places);
    this.#windowUsedLast = kept.windowUsedLast ?? randomUUID();
    this.#pushedRecord = this.#appearance.record;
    this.#appearance.subscribe(() => {
      this.#paintGrounds();
      this.#pushAppearance();
    });
  }

  /**
   * Builds the console window used last at start, at its kept place, loading the renderer and
   * handed its window id; the registry builds it again on a Dock click or a second launch once
   * every window closed, and after the renderer's process went.
   */
  public openFirstWindow(options: FirstWindowOptions): RendererWindow {
    this.#firstWindowArguments = options.additionalArguments;
    return this.#buildFirstWindow(options);
  }

  /** Whether the renderer loaded now is a safe start, which opens without the kept window layout. */
  public get isSafeStart(): boolean {
    return this.#isSafeStart;
  }

  /**
   * Installs the app's window lifecycle; call it before `ready`, so a second launch that arrives
   * while the app starts is heard. Closing the last window quits on Windows and Linux and leaves
   * the app running on macOS, where a Dock click opens a window again; a second launch brings the
   * window used last forward. Before start has built the first window, neither opens one: start
   * is about to.
   */
  public installLifecycle(app: Pick<App, "on" | "quit">): void {
    app.on("before-quit", () => {
      this.#isQuitting = true;
      // Every console window open now comes back at the next start, and only those.
      this.#keepOnlyPlacesOf(this.#windows);
    });
    app.on("window-all-closed", () => {
      if (this.#platform !== "darwin") {
        app.quit();
      }
    });
    app.on("activate", () => {
      if (this.#windows.length === 0) {
        this.#reopenFirstWindow();
      }
    });
    app.on("second-instance", () => {
      const lastUsed = this.#windows[0];
      if (lastUsed === undefined) {
        this.#reopenFirstWindow();
      } else {
        bringWindowForward(lastUsed.rendererWindow.baseWindow, this.#platform);
      }
    });
  }

  /** The window showing `webContents`, or `undefined` when no open window shows it. */
  public windowShowing(webContents: WebContents): BaseWindow | undefined {
    return this.#windows.find(
      (openWindow) => openWindow.rendererWindow.view.webContents === webContents,
    )?.rendererWindow.baseWindow;
  }

  /**
   * The first window again, with start's switches, its load a safe start or not as `reload` says;
   * nothing before start has built it.
   */
  #reopenFirstWindow(reload: RendererReload = "restore"): void {
    if (this.#firstWindowArguments !== undefined) {
      // Set before the build, whose load the console document is served to.
      this.#isSafeStart = reload === "safe-start";
      this.#buildFirstWindow({ additionalArguments: this.#firstWindowArguments });
    }
  }

  #buildFirstWindow(options: FirstWindowOptions): RendererWindow {
    const placeKey = consoleWindowPlaceKey(this.#windowUsedLast);
    const rendererWindow = openRendererWindow({
      ...this.#frameFor(placeKey),
      additionalArguments: [...options.additionalArguments, windowIdSwitch(this.#windowUsedLast)],
      ...(options.beforeLoad === undefined ? {} : { beforeLoad: options.beforeLoad }),
    });
    this.#track({ placeKey, rendererWindow, holdsBridge: true });
    return rendererWindow;
  }

  /** Main's answer to the renderer's `window.open` under one frame name. */
  #openChildWindow = (frameName: string): ((handed: WebContents) => WebContents) | undefined => {
    const placeKey = placeKeyForFrameName(frameName);
    if (placeKey === undefined) {
      return undefined;
    }
    return (handedWebContents) => {
      const rendererWindow = adoptRendererChild(this.#frameFor(placeKey), handedWebContents);
      this.#track({ placeKey, rendererWindow, holdsBridge: false });
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
      bounds: place === undefined ? this.#newWindowBounds() : this.#onScreen(place),
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

  #newWindowBounds(): Rectangle {
    const openBounds = this.#windows
      .filter((openWindow) => !this.#closingAfterCrash.has(openWindow))
      .map((openWindow) => openWindow.rendererWindow.baseWindow.getNormalBounds());
    const previous = openBounds[0];
    const workArea =
      previous === undefined
        ? this.#screen.getPrimaryDisplay().workArea
        : this.#screen.getDisplayMatching(previous).workArea;
    return newWindowBounds(workArea, openBounds);
  }

  #track(openWindow: OpenWindow): void {
    this.#windows.unshift(openWindow);
    const { baseWindow, view } = openWindow.rendererWindow;
    baseWindow.on("focus", () => {
      if (this.#closingAfterCrash.has(openWindow)) {
        return;
      }
      this.#moveToFront(openWindow);
      const windowId = windowIdOfPlaceKey(openWindow.placeKey);
      if (windowId !== undefined && !this.#isQuitting) {
        this.#windowUsedLast = windowId;
      }
    });
    if (openWindow.holdsBridge) {
      baseWindow.on("enter-full-screen", () => {
        view.webContents.send(FULLSCREEN_VALUE_CHANNEL, true);
      });
      baseWindow.on("leave-full-screen", () => {
        view.webContents.send(FULLSCREEN_VALUE_CHANNEL, false);
      });
    }
    // One renderer process draws every window, so its loss reaches each one's document.
    view.webContents.on("render-process-gone", (_event, details: RenderProcessGoneDetails) => {
      // A window already closed, or closing after this same loss, has nothing left to recover.
      const isOpen = this.#windows.includes(openWindow) && !this.#closingAfterCrash.has(openWindow);
      if (isOpen && !this.#isQuitting && !this.#isRecoveryPending) {
        this.#isRecoveryPending = true;
        // Answered on a later task: a reload started inside this handler re-enters the lost
        // process's start and can crash the main process.
        setTimeout(() => {
          this.#recoverFromRendererLoss(details);
        }, 0);
      }
    });
    // `close`, not `closed`: the window's rectangle is still readable. A safe start keeps no place.
    baseWindow.on("close", () => {
      if (!this.#closingAfterCrash.has(openWindow) && !this.#isSafeStart) {
        this.#keepPlace(openWindow);
      }
    });
    baseWindow.once("closed", () => {
      this.#windows.splice(this.#windows.indexOf(openWindow), 1);
      this.#closingAfterCrash.delete(openWindow);
    });
  }

  #moveToFront(openWindow: OpenWindow): void {
    this.#windows.splice(this.#windows.indexOf(openWindow), 1);
    this.#windows.unshift(openWindow);
  }

  /**
   * The renderer's process went, taking every window's document with it. The first window is built
   * again, which reloads the renderer, and the windows that lost their documents close, pruning no
   * place. After the first and second loss in a row every window's place is kept as it stands and
   * the reloaded renderer reopens the rest from its kept layout, each at the place kept here; after
   * the third the reload is a safe start, which leaves every kept place as it was.
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
      this.#closingAfterCrash.add(openWindow);
    }
    if (reload === "restore") {
      for (const openWindow of lost) {
        this.#recordPlace(openWindow);
      }
      this.#writePlaces();
    }
    // Built before the lost windows close, so no moment has every window closed, which would quit
    // the app on Windows and Linux.
    this.#reopenFirstWindow(reload);
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
      // The most recently used console window left is the one built first from now on.
      const nextUsed = others
        .map((openWindow) => windowIdOfPlaceKey(openWindow.placeKey))
        .find((windowId) => windowId !== undefined);
      if (windowIdOfPlaceKey(closing.placeKey) === this.#windowUsedLast && nextUsed !== undefined) {
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
      if (windowIdOfPlaceKey(placeKey) !== undefined && !placeKeys.has(placeKey)) {
        this.#places.delete(placeKey);
      }
    }
  }

  /** The record to every document holding the bridge, once per change of the record itself. */
  #pushAppearance(): void {
    const record = this.#appearance.record;
    if (record === this.#pushedRecord) {
      return;
    }
    this.#pushedRecord = record;
    for (const { rendererWindow, holdsBridge } of this.#windows) {
      // A page's own close destroys its document a moment before its window goes.
      if (holdsBridge && !rendererWindow.view.webContents.isDestroyed()) {
        rendererWindow.view.webContents.send(APPEARANCE_VALUE_CHANNEL, record);
      }
    }
  }

  /** Every open window and its view repainted in the ground the appearance now resolves to. */
  #paintGrounds(): void {
    const ground = this.#appearance.ground;
    for (const { rendererWindow } of this.#windows) {
      rendererWindow.baseWindow.setBackgroundColor(ground);
      rendererWindow.view.setBackgroundColor(ground);
    }
  }
}
