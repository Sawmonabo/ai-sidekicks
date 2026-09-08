// The `BrowserWindow` stand-in the one `electron` mock hands to production code.
//
// SPLIT FROM `./electron-mock.ts`, which owns the `electron` module surface itself —
// `app`, `Menu`, `ipcMain`, `protocol`, the operation log. This file owns one window:
// what a test can read off it, and what it does when the code under test loads a URL,
// focuses it, or destroys it. The mock composes this; nothing else constructs one.
//
// The two are still ONE factory. `electron-mock.ts` stays the single
// `vi.mock("electron")` home and re-exports every shape declared here, so a suite
// imports one module and this split is invisible to it.

import { vi } from "vitest";

/** The `BrowserWindow` constructor options the window factory supplies. */
export interface MockBrowserWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly show: boolean;
  readonly webPreferences: Record<string, unknown>;
}

/** One message `webContents.send` carried, as a test reads it. */
export interface MockWebContentsMessage {
  readonly channel: string;
  readonly payload: unknown;
}

/** The `webContents` surface the main process actually touches. */
export interface MockWebContents {
  readonly id: number;
  /**
   * Every listener registered through `on` / `once`, by event name.
   *
   * Exposed so a test can INVOKE the listener the production code registered —
   * `render-process-gone`, `will-navigate` — rather than re-deriving what it
   * would have done.
   */
  readonly handlers: Map<string, (...args: never[]) => unknown>;
  readonly on: ReturnType<typeof vi.fn>;
  readonly once: ReturnType<typeof vi.fn>;
  readonly setWindowOpenHandler: ReturnType<typeof vi.fn>;
  readonly executeJavaScript: ReturnType<typeof vi.fn>;
  /**
   * Every `send` this `WebContents` was given, in order.
   *
   * Recorded per `WebContents` rather than on the mock, because WHICH renderer a
   * report reached is the property the auxiliary-window handler owes: a report
   * broadcast to every window would tell three decks that a pane none of them holds
   * has come back, and a log kept on the mock could not tell those apart.
   */
  readonly sent: readonly MockWebContentsMessage[];
  readonly send: ReturnType<typeof vi.fn>;
  /** Mark this `WebContents` destroyed, the way a closed window's is. */
  destroy(): void;
  isDestroyed(): boolean;
  /** The handler passed to `setWindowOpenHandler`, or `undefined` if none was. */
  windowOpenHandler: ((details: { url: string }) => unknown) | undefined;
}

/** One constructed window. */
export interface MockBrowserWindow {
  readonly id: number;
  readonly options: MockBrowserWindowOptions;
  readonly webContents: MockWebContents;
  /** Every URL `loadURL` was called with, in order. */
  readonly loadedUrls: readonly string[];
  /** Listeners registered on the window itself (`ready-to-show`). */
  readonly onceHandlers: Map<string, () => void>;
  /** How many times this window was brought forward. */
  readonly focusCount: number;
  /**
   * How many times this window was asked to close.
   *
   * Counted rather than collapsed into `isDestroyed`, because the two are different
   * facts and a suite over the close path needs the difference: Electron's `close`
   * runs the window's own teardown and fires `closed`, and this mock deliberately
   * fires neither — the suites drive `onceHandlers.get("closed")` by hand, which is
   * what lets a case assert what a close DID before deciding what the ending reports.
   */
  readonly closeCount: number;
  isDestroyed(): boolean;
  destroy(): void;
  show(): void;
  focus(): void;
  close(): void;
  once(eventName: string, handler: () => void): MockBrowserWindow;
  on(eventName: string, handler: () => void): MockBrowserWindow;
  loadURL(url: string): Promise<void>;
}

/**
 * What a window needs from the mock that owns it.
 *
 * A NARROW view rather than the mock's own type, and that narrowness is the point:
 * the window mints an id, records what it did, and asks whether this URL was armed
 * to fail. Handing it the whole mock would let a later edit reach for the menu log
 * or the `ipcMain` registry from inside a window, which is the coupling this split
 * exists to remove.
 */
export interface MockWindowHost {
  record(operation: string): void;
  recordConstruction(browserWindow: MockBrowserWindow): void;
  mintWindowId(): number;
  loadFailureFor(url: string): Error | undefined;
}

/**
 * One mocked window.
 *
 * A class rather than an object literal because it owns state (its destroyed
 * flag, its load log, its listener maps) and because the `electron` mock hands
 * it to production code as a constructor.
 */
export class MockBrowserWindowImpl implements MockBrowserWindow {
  public readonly id: number;
  public readonly webContents: MockWebContents;
  public readonly loadedUrls: string[] = [];
  public readonly onceHandlers: Map<string, () => void> = new Map<string, () => void>();
  #focusCount = 0;
  #closeCount = 0;
  #destroyed = false;
  readonly #mock: MockWindowHost;

  public constructor(
    mock: MockWindowHost,
    public readonly options: MockBrowserWindowOptions,
  ) {
    this.#mock = mock;
    this.id = mock.mintWindowId();
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const sent: MockWebContentsMessage[] = [];
    let isDestroyed = false;
    const webContents: MockWebContents = {
      id: this.id * 1000,
      handlers,
      sent,
      send: vi.fn((channel: string, payload: unknown) => {
        if (isDestroyed) {
          // Electron throws here, and the production code is written to check first.
          throw new Error("Object has been destroyed");
        }
        sent.push({ channel, payload });
      }),
      destroy: () => {
        isDestroyed = true;
      },
      isDestroyed: () => isDestroyed,
      on: vi.fn((eventName: string, handler: (...args: never[]) => unknown) => {
        handlers.set(eventName, handler);
        mock.record(`webContents.on:${eventName}`);
      }),
      once: vi.fn((eventName: string, handler: (...args: never[]) => unknown) => {
        handlers.set(eventName, handler);
        mock.record(`webContents.once:${eventName}`);
      }),
      setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => unknown) => {
        webContents.windowOpenHandler = handler;
        mock.record("webContents.setWindowOpenHandler");
      }),
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      windowOpenHandler: undefined,
    };
    this.webContents = webContents;
    mock.recordConstruction(this);
  }

  public once(eventName: string, handler: () => void): MockBrowserWindow {
    this.onceHandlers.set(eventName, handler);
    return this;
  }

  public on(eventName: string, handler: () => void): MockBrowserWindow {
    this.onceHandlers.set(eventName, handler);
    return this;
  }

  public show(): void {
    // A real window paints here; nothing to record.
  }

  public get focusCount(): number {
    return this.#focusCount;
  }

  public focus(): void {
    this.#focusCount += 1;
    this.#mock.record("focus");
  }

  public get closeCount(): number {
    return this.#closeCount;
  }

  public close(): void {
    this.#closeCount += 1;
    this.#mock.record("close");
  }

  public isDestroyed(): boolean {
    return this.#destroyed;
  }

  public destroy(): void {
    this.#destroyed = true;
    this.#mock.record("destroy");
  }

  public loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    this.#mock.record(`loadURL:${url}`);
    const failure = this.#mock.loadFailureFor(url);
    return failure === undefined ? Promise.resolve() : Promise.reject(failure);
  }
}
