// The window stand-ins the one `electron` mock hands to production code: `BaseWindow`, the
// `WebContentsView` it hosts, and the view's `webContents`. Each records what a test reads (URLs
// loaded, pushes sent, listeners registered) and does what the code under test relies on: a close
// fires `close` then `closed`, a destroyed `webContents` fires `destroyed`, and every listener on
// an event runs, a `once` one only the first time, as Electron's emitters do. `module.ts` owns
// the rest of the `electron` module.

import { vi } from "vitest";

/** A rectangle as Electron's window and screen calls take and answer it. */
export interface MockRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The `BaseWindow` constructor options the window factory supplies. */
export interface MockBaseWindowOptions extends MockRectangle {
  readonly show: boolean;
  readonly titleBarStyle?: string;
  readonly backgroundColor?: string;
}

/** The `WebContentsView` constructor options the window factory supplies. */
export interface MockWebContentsViewOptions {
  readonly webPreferences: Record<string, unknown>;
  readonly webContents?: MockWebContents;
}

/** What a window-open handler is handed. */
export interface MockWindowOpenDetails {
  readonly url: string;
  readonly frameName: string;
}

/** The `webContents` members the main process touches. */
export interface MockWebContents {
  readonly id: number;
  readonly on: ReturnType<typeof vi.fn>;
  readonly once: ReturnType<typeof vi.fn>;
  readonly setWindowOpenHandler: ReturnType<typeof vi.fn>;
  readonly setBackgroundThrottling: ReturnType<typeof vi.fn>;
  readonly executeJavaScript: ReturnType<typeof vi.fn>;
  /** Every URL `loadURL` was called with, in order. */
  readonly loadedUrls: readonly string[];
  /** Every `send(channel, value)` main made to this document, in order. */
  readonly sent: readonly { readonly channel: string; readonly value: unknown }[];
  /** The handler passed to `setWindowOpenHandler`, or `undefined` if none was. */
  windowOpenHandler: ((details: MockWindowOpenDetails) => unknown) | undefined;
  loadURL(url: string): Promise<void>;
  send(channel: string, value: unknown): void;
  /** Fire every listener registered for `eventName` with `args`, as Electron would emit it. */
  emit(eventName: string, ...args: unknown[]): void;
  /**
   * The listeners registered for `eventName` and not yet spent, so a test can invoke the one
   * production code registered instead of re-deriving it.
   */
  listenersOf(eventName: string): readonly ((...args: never[]) => unknown)[];
  /** Destroys this document and fires `destroyed`, as a page's own `window.close()` does. */
  close(): void;
  isDestroyed(): boolean;
}

/** One constructed view. */
export interface MockWebContentsView {
  readonly options: MockWebContentsViewOptions;
  readonly webContents: MockWebContents;
  readonly bounds: MockRectangle | undefined;
  readonly backgroundColor: string | undefined;
  setBounds(bounds: MockRectangle): void;
  setBackgroundColor(color: string): void;
}

/** One constructed window. */
export interface MockBaseWindow {
  readonly id: number;
  readonly options: MockBaseWindowOptions;
  readonly contentView: {
    readonly children: readonly MockWebContentsView[];
    addChildView(view: MockWebContentsView): void;
  };
  readonly title: string;
  readonly backgroundColor: string | undefined;
  readonly minimumSize: readonly [number, number] | undefined;
  /** How many times this window was shown, actively or not. */
  readonly showCount: number;
  /** How many times this window was focused. */
  readonly focusCount: number;
  on(eventName: string, listener: (...args: never[]) => unknown): MockBaseWindow;
  once(eventName: string, listener: (...args: never[]) => unknown): MockBaseWindow;
  /** Fire every listener registered for `eventName`, as Electron would emit the event. */
  emit(eventName: string): void;
  show(): void;
  showInactive(): void;
  focus(): void;
  restore(): void;
  maximize(): void;
  setFullScreen(isFullScreen: boolean): void;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isMinimized(): boolean;
  /** Whether the window was shown and has not closed since. */
  isVisible(): boolean;
  setTitle(title: string): void;
  setBackgroundColor(color: string): void;
  setMinimumSize(width: number, height: number): void;
  setBounds(bounds: MockRectangle): void;
  getContentBounds(): MockRectangle;
  getNormalBounds(): MockRectangle;
  /** Fires `close`, then `closed`, and leaves the window destroyed; throws once it is destroyed. */
  close(): void;
  /** Fires `closed` without `close`, as Electron's `destroy` does. */
  destroy(): void;
  isDestroyed(): boolean;
}

/**
 * What a window, view or document needs from the mock that owns it. A narrow view rather than the
 * mock's own type, so a window cannot reach the menu log or the `ipcMain` registry.
 */
export interface MockWindowOwner {
  record(operation: string): void;
  recordConstruction(baseWindow: MockBaseWindow): void;
  recordView(view: MockWebContentsView): void;
  forgetWindow(baseWindow: MockBaseWindow): void;
  mintId(): number;
  loadFailureFor(url: string): Error | undefined;
}

/**
 * The listeners of one emitter, by event name. Every listener on an event runs, in the order it was
 * added, and one added with `once` is removed before it runs, as Node's `EventEmitter` does.
 */
export class MockEventListeners {
  readonly #listeners = new Map<string, ((...args: never[]) => unknown)[]>();

  /** Adds `listener` for every later `eventName`. */
  public on(eventName: string, listener: (...args: never[]) => unknown): void {
    this.#listeners.set(eventName, [...this.listenersOf(eventName), listener]);
  }

  /** Adds `listener` for the next `eventName` only. */
  public once(eventName: string, listener: (...args: never[]) => unknown): void {
    const onceListener = (...args: never[]): unknown => {
      this.#listeners.set(
        eventName,
        this.listenersOf(eventName).filter((each) => each !== onceListener),
      );
      return listener(...args);
    };
    this.on(eventName, onceListener);
  }

  /** Runs every listener for `eventName` with `args`. */
  public emit(eventName: string, ...args: unknown[]): void {
    for (const listener of this.listenersOf(eventName)) {
      (listener as (...listenerArgs: unknown[]) => unknown)(...args);
    }
  }

  /** The listeners for `eventName` not yet spent. */
  public listenersOf(eventName: string): readonly ((...args: never[]) => unknown)[] {
    return this.#listeners.get(eventName) ?? [];
  }
}

/** Builds one mocked `webContents`, for a view or for a `window.open` child a test hands main. */
export function createMockWebContents(owner: MockWindowOwner): MockWebContents {
  const listeners = new MockEventListeners();
  const loadedUrls: string[] = [];
  const sent: { channel: string; value: unknown }[] = [];
  let isDestroyed = false;
  const webContents: MockWebContents = {
    id: owner.mintId(),
    loadedUrls,
    sent,
    windowOpenHandler: undefined,
    on: vi.fn((eventName: string, listener: (...args: never[]) => unknown) => {
      listeners.on(eventName, listener);
      owner.record(`webContents.on:${eventName}`);
    }),
    once: vi.fn((eventName: string, listener: (...args: never[]) => unknown) => {
      listeners.once(eventName, listener);
      owner.record(`webContents.once:${eventName}`);
    }),
    setWindowOpenHandler: vi.fn((handler: (details: MockWindowOpenDetails) => unknown) => {
      webContents.windowOpenHandler = handler;
      owner.record("webContents.setWindowOpenHandler");
    }),
    setBackgroundThrottling: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
    loadURL: (url) => {
      loadedUrls.push(url);
      owner.record(`loadURL:${url}`);
      const failure = owner.loadFailureFor(url);
      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
    },
    send: (channel, value) => {
      sent.push({ channel, value });
    },
    emit: (eventName, ...args) => {
      listeners.emit(eventName, ...args);
    },
    listenersOf: (eventName) => listeners.listenersOf(eventName),
    close: () => {
      if (isDestroyed) {
        return;
      }
      isDestroyed = true;
      webContents.emit("destroyed");
    },
    isDestroyed: () => isDestroyed,
  };
  return webContents;
}

/** One mocked view; the `electron` mock hands it to production code as a constructor. */
export class MockWebContentsViewImpl implements MockWebContentsView {
  public readonly webContents: MockWebContents;
  #bounds: MockRectangle | undefined;
  #backgroundColor: string | undefined;

  public constructor(
    owner: MockWindowOwner,
    public readonly options: MockWebContentsViewOptions,
  ) {
    this.webContents = options.webContents ?? createMockWebContents(owner);
    owner.recordView(this);
  }

  public get bounds(): MockRectangle | undefined {
    return this.#bounds;
  }

  public get backgroundColor(): string | undefined {
    return this.#backgroundColor;
  }

  public setBounds(bounds: MockRectangle): void {
    this.#bounds = bounds;
  }

  public setBackgroundColor(color: string): void {
    this.#backgroundColor = color;
  }
}

/** One mocked window; the `electron` mock hands it to production code as a constructor. */
export class MockBaseWindowImpl implements MockBaseWindow {
  public readonly id: number;
  public readonly contentView: {
    readonly children: MockWebContentsView[];
    addChildView(view: MockWebContentsView): void;
  };
  readonly #owner: MockWindowOwner;
  readonly #listeners = new MockEventListeners();
  #bounds: MockRectangle;
  #title = "";
  #backgroundColor: string | undefined;
  #minimumSize: readonly [number, number] | undefined;
  #showCount = 0;
  #focusCount = 0;
  #isMaximized = false;
  #isFullScreen = false;
  #isDestroyed = false;

  public constructor(
    owner: MockWindowOwner,
    public readonly options: MockBaseWindowOptions,
  ) {
    this.#owner = owner;
    this.id = owner.mintId();
    this.#bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.#backgroundColor = options.backgroundColor;
    const children: MockWebContentsView[] = [];
    this.contentView = {
      children,
      addChildView: (view) => {
        children.push(view);
      },
    };
    owner.recordConstruction(this);
  }

  public get title(): string {
    return this.#title;
  }

  public get backgroundColor(): string | undefined {
    return this.#backgroundColor;
  }

  public get minimumSize(): readonly [number, number] | undefined {
    return this.#minimumSize;
  }

  public get showCount(): number {
    return this.#showCount;
  }

  public get focusCount(): number {
    return this.#focusCount;
  }

  public on(eventName: string, listener: (...args: never[]) => unknown): MockBaseWindow {
    this.#listeners.on(eventName, listener);
    return this;
  }

  public once(eventName: string, listener: (...args: never[]) => unknown): MockBaseWindow {
    this.#listeners.once(eventName, listener);
    return this;
  }

  public emit(eventName: string): void {
    this.#listeners.emit(eventName);
  }

  public show(): void {
    this.#showCount += 1;
    this.#owner.record("show");
  }

  public showInactive(): void {
    this.#showCount += 1;
    this.#owner.record("showInactive");
  }

  public focus(): void {
    this.#focusCount += 1;
    this.#owner.record("focus");
  }

  public restore(): void {
    this.#owner.record("restore");
  }

  public maximize(): void {
    this.#isMaximized = true;
    this.#owner.record("maximize");
  }

  public setFullScreen(isFullScreen: boolean): void {
    this.#isFullScreen = isFullScreen;
    this.#owner.record(`setFullScreen:${String(isFullScreen)}`);
  }

  public isMaximized(): boolean {
    return this.#isMaximized;
  }

  public isFullScreen(): boolean {
    return this.#isFullScreen;
  }

  public isMinimized(): boolean {
    return false;
  }

  public isVisible(): boolean {
    return this.#showCount > 0 && !this.#isDestroyed;
  }

  public setTitle(title: string): void {
    this.#title = title;
  }

  public setBackgroundColor(color: string): void {
    this.#backgroundColor = color;
  }

  public setMinimumSize(width: number, height: number): void {
    this.#minimumSize = [width, height];
  }

  public setBounds(bounds: MockRectangle): void {
    this.#bounds = bounds;
  }

  public getContentBounds(): MockRectangle {
    return this.#bounds;
  }

  public getNormalBounds(): MockRectangle {
    return this.#bounds;
  }

  public close(): void {
    if (this.#isDestroyed) {
      // Electron's own answer to a call on a window already gone.
      throw new TypeError("Object has been destroyed");
    }
    this.#owner.record("close");
    this.emit("close");
    this.#end();
  }

  public destroy(): void {
    if (this.#isDestroyed) {
      return;
    }
    this.#owner.record("destroy");
    this.#end();
  }

  public isDestroyed(): boolean {
    return this.#isDestroyed;
  }

  #end(): void {
    this.#isDestroyed = true;
    this.#owner.forgetWindow(this);
    this.emit("closed");
  }
}
