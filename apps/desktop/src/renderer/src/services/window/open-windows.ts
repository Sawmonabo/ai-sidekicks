// The windows a person sees, as the console document holds them. The console document opens each
// with `window.open` under its window id as the frame name, and main builds the native window
// around it; this keeps each open one's `Window`, gives it a copy of the console document's
// stylesheets, paces the shared frames by it, and hears it close. A person closes a window from its
// own frame, so a close is heard on the window's `pagehide` and settled on the next task, once
// `closed` reads true; a close the console document's own unloading causes is not a person's and
// is not published.

import type { Unsubscribe } from "@shared/preload-api.js";
import type { OpenWindowFrames } from "@renderer/lib/open-window-frames.js";
import { StylesheetMirror } from "./stylesheet-mirror.js";

/**
 * Opens a window under a frame name, as `window.open("about:blank", windowId)` does; `null` when
 * none was opened.
 */
export type WindowOpener = (windowId: string) => Window | null;

/** One window the console document opened. */
export interface OpenWindow {
  /** The window's id, the frame name it was opened under. */
  readonly windowId: string;
  readonly window: Window;
}

/** What {@link OpenWindows} is built over. */
export interface OpenWindowsOptions {
  readonly openWindow: WindowOpener;
  /** The console document, whose stylesheets every window copies. */
  readonly consoleDocument: Document;
  /** The shared frames, paced by every open window. */
  readonly frames: OpenWindowFrames;
}

/** Raised when the platform opened no window for an id. */
export class WindowNotOpenedError extends Error {
  public constructor(windowId: string) {
    super(`No window opened for ${windowId}.`);
    this.name = "WindowNotOpenedError";
  }
}

/**
 * The open windows, the window used last first. A listener hears every open and close; a window
 * already open is brought forward rather than opened twice, since opening its name again would
 * load a blank page over it.
 */
export class OpenWindows {
  readonly #options: OpenWindowsOptions;
  readonly #held = new Map<string, HeldWindow>();
  readonly #listeners = new Set<() => void>();
  readonly #documentPreparations = new Set<(windowDocument: Document) => void>();
  #usedLastFirst: readonly OpenWindow[] = [];
  #isConsoleUnloading = false;

  public constructor(options: OpenWindowsOptions) {
    this.#options = options;
    options.consoleDocument.defaultView?.addEventListener("pagehide", () => {
      this.#isConsoleUnloading = true;
    });
  }

  /**
   * Open the window `windowId` names, or bring it forward when it is open. Throws
   * {@link WindowNotOpenedError} when the platform opened none.
   */
  public open(windowId: string): OpenWindow {
    const held = this.#held.get(windowId);
    if (held !== undefined) {
      held.openWindow.window.focus();
      return held.openWindow;
    }
    const opened = this.#options.openWindow(windowId);
    if (opened === null) {
      throw new WindowNotOpenedError(windowId);
    }
    const openWindow: OpenWindow = { windowId, window: opened };
    for (const prepare of this.#documentPreparations) {
      prepare(opened.document);
    }
    const mirror = new StylesheetMirror(this.#options.consoleDocument, opened.document);
    const onFocus = (): void => {
      this.#bringForward(windowId);
    };
    const onPageHide = (): void => {
      // `closed` reads true only once the close has gone through, after this task.
      globalThis.setTimeout(() => {
        if (opened.closed && !this.#isConsoleUnloading) {
          this.#forget(windowId);
        }
      }, 0);
    };
    opened.addEventListener("focus", onFocus);
    opened.addEventListener("pagehide", onPageHide);
    this.#held.set(windowId, {
      openWindow,
      release: () => {
        opened.removeEventListener("focus", onFocus);
        opened.removeEventListener("pagehide", onPageHide);
        mirror.disconnect();
        this.#options.frames.release(opened);
      },
    });
    this.#options.frames.hold(opened);
    this.#usedLastFirst = [...this.#usedLastFirst, openWindow];
    this.#publish();
    return openWindow;
  }

  /** Close one window and forget it. Nothing for a window not open. */
  public close(windowId: string): void {
    const held = this.#held.get(windowId);
    if (held === undefined) {
      return;
    }
    this.#forget(windowId);
    held.openWindow.window.close();
  }

  /** Close every window; the console document's own teardown. */
  public closeAll(): void {
    for (const windowId of [...this.#held.keys()]) {
      this.close(windowId);
    }
  }

  /** The open windows, the one used last first. The same array until the next change. */
  public list(): readonly OpenWindow[] {
    return this.#usedLastFirst;
  }

  /** Hear every open, close and change of the window used last. */
  public subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Run `prepare` on every open window's document now and on each window opened after, before
   * anything is drawn in it, until the returned call.
   */
  public prepareEveryDocument(prepare: (windowDocument: Document) => void): Unsubscribe {
    this.#documentPreparations.add(prepare);
    for (const { window } of this.#usedLastFirst) {
      prepare(window.document);
    }
    return () => {
      this.#documentPreparations.delete(prepare);
    };
  }

  #bringForward(windowId: string): void {
    const focused = this.#held.get(windowId)?.openWindow;
    if (focused === undefined || this.#usedLastFirst[0] === focused) {
      return;
    }
    this.#usedLastFirst = [focused, ...this.#usedLastFirst.filter((each) => each !== focused)];
    this.#publish();
  }

  #forget(windowId: string): void {
    const held = this.#held.get(windowId);
    if (held === undefined) {
      return;
    }
    this.#held.delete(windowId);
    held.release();
    this.#usedLastFirst = this.#usedLastFirst.filter((each) => each !== held.openWindow);
    this.#publish();
  }

  #publish(): void {
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

/** One open window and what undoes holding it. */
interface HeldWindow {
  readonly openWindow: OpenWindow;
  readonly release: () => void;
}
