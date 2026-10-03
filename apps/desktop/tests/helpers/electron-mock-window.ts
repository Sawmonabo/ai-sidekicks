// The `BrowserWindow` stand-in the one `electron` mock hands to production code: what a test can
// read off one window, and what it does when the code under test loads a URL, focuses it, or
// destroys it. `electron-mock.ts` owns the rest of the `electron` module.

import { vi } from "vitest";

/** The `BrowserWindow` constructor options the window factory supplies. */
export interface MockBrowserWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly show: boolean;
  readonly webPreferences: Record<string, unknown>;
}

/** The `webContents` members the main process actually touches. */
export interface MockWebContents {
  readonly id: number;
  /**
   * Every listener registered through `on` / `once`, by event name.
   *
   * Lets a test invoke the listener production code registered (`render-process-gone`,
   * `will-navigate`) instead of re-deriving what it would have done.
   */
  readonly handlers: Map<string, (...args: never[]) => unknown>;
  readonly on: ReturnType<typeof vi.fn>;
  readonly once: ReturnType<typeof vi.fn>;
  readonly setWindowOpenHandler: ReturnType<typeof vi.fn>;
  readonly executeJavaScript: ReturnType<typeof vi.fn>;
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
  /** How many times this window was brought forward. */
  readonly focusCount: number;
  /**
   * How many times this window was asked to close.
   *
   * Counted apart from `isDestroyed` because Electron's `close` runs the window's teardown and
   * fires `closed`, and this mock does neither, so a case can assert what a close did before
   * deciding what the ending reports.
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
 * A narrow view rather than the mock's own type, so a window cannot reach the menu log or the
 * `ipcMain` registry.
 */
export interface MockWindowOwner {
  record(operation: string): void;
  recordConstruction(browserWindow: MockBrowserWindow): void;
  mintWindowId(): number;
  loadFailureFor(url: string): Error | undefined;
}

/**
 * One mocked window.
 *
 * A class because it owns state (destroyed flag, load log, listener maps) and the `electron`
 * mock hands it to production code as a constructor.
 */
export class MockBrowserWindowImpl implements MockBrowserWindow {
  public readonly id: number;
  public readonly webContents: MockWebContents;
  public readonly loadedUrls: string[] = [];
  #focusCount = 0;
  #closeCount = 0;
  #destroyed = false;
  readonly #mock: MockWindowOwner;

  public constructor(
    mock: MockWindowOwner,
    public readonly options: MockBrowserWindowOptions,
  ) {
    this.#mock = mock;
    this.id = mock.mintWindowId();
    const handlers = new Map<string, (...args: never[]) => unknown>();
    let isDestroyed = false;
    const webContents: MockWebContents = {
      id: this.id * 1000,
      handlers,
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

  // No suite fires a listener on the window itself, so neither registration is recorded.
  public on(): MockBrowserWindow {
    return this;
  }

  public once(): MockBrowserWindow {
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
