// The one `electron` module mock — Plan-023 Phase 1B.
//
// Three main-process suites need a fake `electron`, and before this module each
// hand-rolled its own `vi.mock("electron", …)` factory with its own
// `MockBrowserWindow` class. The three were near-identical and already
// divergent: one recorded a call order and two did not, one modelled
// `setWindowOpenHandler` and two did not, and each named the same operations
// differently. That is the failure mode a shared harness exists to prevent —
// two copies of one behaviour drift, and the suite that is missing the arm goes
// green on the regression the other one would have caught.
//
// One factory, parameterised. `recordOrder` turns on the ordered operation log
// (a suite asserting sequence needs it; one asserting shape does not want the
// noise), and `packaged` sets the initial `app.isPackaged`. Everything else —
// which windows were constructed, which URLs were loaded, which externals were
// opened, which menu templates were installed — is always recorded, because
// recording costs an array push and a suite that does not read a field pays
// nothing for it.
//
// USAGE. The mock instance must exist before the `vi.mock` factory RUNS, not
// before it is registered: `vi.mock` is hoisted above the module body, but its
// factory is invoked lazily, when the module under test first imports
// `electron`. So the working shape is a top-level `const` plus a dynamic import
// of the module under test:
//
//     const electronMock = createElectronMock({ recordOrder: true });
//     vi.mock("electron", () => electronMock.moduleExports);
//     // …then, inside a test: await import("./window.js")
//
// A suite that STATICALLY imports the module under test cannot use this shape —
// the static import evaluates during the test file's own import phase, before
// the `const` initialises, and the factory would read a binding still in its
// temporal dead zone. Those suites keep a local factory (see
// `src/main/protocol.test.ts` and `src/main/navigation.test.ts`, neither of
// which constructs a window); the suites over the `electron`-free modules —
// `src/main/renderer-assets.test.ts`, `src/main/load-failure-document.test.ts`,
// `src/main/renderer-scheme.test.ts` — need no mock at all.
//
// The reading helpers the four window suites share (the `MockBrowserWindow`
// cast, the listener accessors, the policy-operation prefix) live beside this
// module in `./window-test-harness.ts`.

import { vi } from "vitest";

/**
 * One entry of a `Menu.buildFromTemplate` template, as a test reads it.
 *
 * Declared here rather than in each suite so the two menu-shaped assertions in
 * the tree agree on the shape they are asserting.
 */
export interface MenuTemplateItem {
  readonly label?: string;
  readonly role?: string;
  readonly type?: string;
  readonly accelerator?: string;
  readonly click?: () => void;
  readonly submenu?: MenuTemplateItem[];
}

/** The `BrowserWindow` constructor options the window factory supplies. */
export interface MockBrowserWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly show: boolean;
  readonly webPreferences: Record<string, unknown>;
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
  isDestroyed(): boolean;
  destroy(): void;
  show(): void;
  once(eventName: string, handler: () => void): MockBrowserWindow;
  on(eventName: string, handler: () => void): MockBrowserWindow;
  loadURL(url: string): Promise<void>;
}

/** How to parameterise the mock. */
export interface ElectronMockOptions {
  /**
   * Record an ordered log of every mocked operation into `operations`.
   *
   * Off by default: a suite that asserts SHAPE does not want an ordering it
   * did not ask for, and an unread log is a field a reader has to rule out.
   */
  readonly recordOrder?: boolean;
  /** The initial `app.isPackaged`. Defaults to `true` — the shipped posture. */
  readonly packaged?: boolean;
}

/** The mock, its recordings, and its controls. */
export interface ElectronMock {
  /** What the `vi.mock("electron", …)` factory returns. */
  readonly moduleExports: Record<string, unknown>;
  /** Every window constructed since the last `reset()`, in order. */
  readonly constructed: readonly MockBrowserWindow[];
  /** The ordered operation log; empty unless `recordOrder` was set. */
  readonly operations: readonly string[];
  /** Every `app.exit(code)` code, in order. */
  readonly exitCodes: readonly number[];
  /** Every URL handed to `shell.openExternal`, in order. */
  readonly externalOpens: readonly string[];
  /** Every template handed to `Menu.setApplicationMenu`, in order. */
  readonly installedMenuTemplates: readonly MenuTemplateItem[][];

  /** Clears every recording and restores the initial `packaged` value. */
  reset(): void;
  /** Sets `app.isPackaged` for the next module load. */
  setPackaged(packaged: boolean): void;
  /**
   * Makes every `loadURL` whose URL CONTAINS `substring` reject with `error`.
   *
   * Substring rather than equality so one call can fail the bundle load, the
   * failure-document load, or both, without a test restating either URL.
   */
  failLoadsContaining(substring: string, error: Error): void;
  /**
   * Re-arms `app.whenReady()` with a fresh unresolved promise and clears the
   * operation log.
   *
   * `whenReady` is a DEFERRED the test resolves by hand: awaiting a dynamic
   * `import()` already drains several microtask ticks, so an already-resolved
   * promise would run the ready continuation before a test could observe the
   * module-evaluation-only prefix, and "registered before ready" would be
   * untestable.
   */
  armReady(): void;
  /** Resolves the promise `app.whenReady()` returned. */
  releaseReady(): void;
}

/**
 * One mocked window.
 *
 * A class rather than an object literal because it owns state (its destroyed
 * flag, its load log, its listener maps) and because the `electron` mock hands
 * it to production code as a constructor.
 */
class MockBrowserWindowImpl implements MockBrowserWindow {
  public readonly id: number;
  public readonly webContents: MockWebContents;
  public readonly loadedUrls: string[] = [];
  public readonly onceHandlers = new Map<string, () => void>();
  #destroyed = false;
  readonly #mock: ElectronMockImpl;

  public constructor(
    mock: ElectronMockImpl,
    public readonly options: MockBrowserWindowOptions,
  ) {
    this.#mock = mock;
    this.id = mock.mintWindowId();
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const webContents: MockWebContents = {
      id: this.id * 1000,
      handlers,
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

/** The mock's own state and the `electron` surface built over it. */
class ElectronMockImpl implements ElectronMock {
  public readonly moduleExports: Record<string, unknown>;
  public readonly constructed: MockBrowserWindow[] = [];
  public readonly operations: string[] = [];
  public readonly exitCodes: number[] = [];
  public readonly externalOpens: string[] = [];
  public readonly installedMenuTemplates: MenuTemplateItem[][] = [];

  readonly #recordOrder: boolean;
  readonly #initialPackaged: boolean;
  readonly #loadFailures: { readonly substring: string; readonly error: Error }[] = [];
  #packaged: boolean;
  #nextWindowId = 1;
  #releaseReady: () => void = () => {};
  #readyPromise: Promise<void>;

  public constructor(options: ElectronMockOptions) {
    this.#recordOrder = options.recordOrder ?? false;
    this.#initialPackaged = options.packaged ?? true;
    this.#packaged = this.#initialPackaged;
    this.#readyPromise = new Promise<void>((resolve) => {
      this.#releaseReady = resolve;
    });
    this.moduleExports = this.#buildModuleExports();
  }

  /** Appends to the ordered log when the suite asked for one. */
  public record(operation: string): void {
    if (this.#recordOrder) {
      this.operations.push(operation);
    }
  }

  public recordConstruction(browserWindow: MockBrowserWindow): void {
    this.constructed.push(browserWindow);
    this.record("construct");
  }

  public mintWindowId(): number {
    return this.#nextWindowId++;
  }

  public loadFailureFor(url: string): Error | undefined {
    return this.#loadFailures.find((failure) => url.includes(failure.substring))?.error;
  }

  public reset(): void {
    this.constructed.length = 0;
    this.operations.length = 0;
    this.exitCodes.length = 0;
    this.externalOpens.length = 0;
    this.installedMenuTemplates.length = 0;
    this.#loadFailures.length = 0;
    this.#nextWindowId = 1;
    this.#packaged = this.#initialPackaged;
  }

  public setPackaged(packaged: boolean): void {
    this.#packaged = packaged;
  }

  public failLoadsContaining(substring: string, error: Error): void {
    this.#loadFailures.push({ substring, error });
  }

  public armReady(): void {
    this.operations.length = 0;
    this.#readyPromise = new Promise<void>((resolve) => {
      this.#releaseReady = resolve;
    });
  }

  public releaseReady(): void {
    this.#releaseReady();
  }

  #buildModuleExports(): Record<string, unknown> {
    // Arrows rather than an aliased `this`: each closure reads the live field
    // at call time, so `setPackaged` and `armReady` are observed by a module
    // that captured `app` at import time.
    const readPackaged = (): boolean => this.#packaged;
    const awaitReady = (): Promise<void> => {
      this.record("app.whenReady");
      return this.#readyPromise;
    };

    return {
      app: {
        get isPackaged(): boolean {
          return readPackaged();
        },
        requestSingleInstanceLock: vi.fn(() => true),
        whenReady: vi.fn(awaitReady),
        on: vi.fn(),
        quit: vi.fn(() => {
          this.record("app.quit");
        }),
        exit: vi.fn((code: number) => {
          this.exitCodes.push(code);
          this.record(`app.exit:${String(code)}`);
        }),
      },
      BrowserWindow: createBoundBrowserWindowClass(this),
      Menu: {
        // Handed straight through: the assertions read the template the module
        // built, which is the whole of what a menu module decides. What
        // Electron then renders is Electron's.
        buildFromTemplate: vi.fn((template: MenuTemplateItem[]) => template),
        setApplicationMenu: vi.fn((template: MenuTemplateItem[]) => {
          this.installedMenuTemplates.push(template);
          this.record("Menu.setApplicationMenu");
        }),
      },
      shell: {
        openExternal: vi.fn((url: string) => {
          this.externalOpens.push(url);
          return Promise.resolve();
        }),
      },
      protocol: {
        registerSchemesAsPrivileged: vi.fn(() => {
          this.record("protocol.registerSchemesAsPrivileged");
        }),
        handle: vi.fn(() => {
          this.record("protocol.handle");
        }),
      },
      net: { fetch: vi.fn() },
    };
  }
}

/**
 * Binds the window class to one mock instance.
 *
 * A factory rather than a class declared inside the method, so the binding is
 * an argument instead of an aliased `this` — the `electron` surface hands
 * production code a CONSTRUCTOR, and a constructor cannot close over `this`
 * through an arrow the way every other member here does.
 */
function createBoundBrowserWindowClass(
  mock: ElectronMockImpl,
): new (options: MockBrowserWindowOptions) => MockBrowserWindow {
  return class BoundBrowserWindow extends MockBrowserWindowImpl {
    public constructor(options: MockBrowserWindowOptions) {
      super(mock, options);
    }
  };
}

/**
 * Builds one `electron` module mock.
 *
 * Call at the top level of a suite and hand `moduleExports` to `vi.mock`; see
 * this module's header for why the instance must be a top-level `const` and why
 * the module under test must be imported dynamically.
 */
export function createElectronMock(options: ElectronMockOptions = {}): ElectronMock {
  return new ElectronMockImpl(options);
}
