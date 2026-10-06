// The one `electron` module mock.
//
// One factory, parameterized, so main-process suites do not each hand-roll a `vi.mock("electron")`
// factory and drift apart. `recordOrder` turns on the ordered operation log (a suite asserting
// sequence needs it; one asserting shape does not want the noise), and `packaged` sets the initial
// `app.isPackaged`. Everything else (windows and views constructed, URLs loaded, externals opened,
// menu templates installed, app listeners) is always recorded.
//
// Usage: the mock instance must exist before the `vi.mock` factory runs, not before it is
// registered. `vi.mock` is hoisted, but its factory runs lazily when the module under test first
// imports `electron`, so the working shape is a top-level `const` plus a dynamic import:
//
//     const electronMock = createElectronMock({ recordOrder: true });
//     vi.mock("electron", () => electronMock.moduleExports);
//     // …then, inside a test: await import("./factory.js")
//
// A suite that statically imports the module under test cannot use this shape: the static import
// evaluates before the `const` initializes, so the factory would read a binding in its temporal
// dead zone. Such a suite keeps a local factory (`src/main/services/renderer/protocol.test.ts`).
//
// The reading helpers the window suites share live in `readers.ts`.

import { vi } from "vitest";

import {
  MockBaseWindowImpl,
  MockWebContentsViewImpl,
  type MockBaseWindow,
  type MockBaseWindowOptions,
  type MockRectangle,
  type MockWebContentsView,
  type MockWebContentsViewOptions,
} from "./window.js";
import { INDEX_URL } from "./readers.js";

/**
 * One entry of a `Menu.buildFromTemplate` template, as a test reads it.
 *
 * Declared here so menu assertions agree on the shape.
 */
export interface MenuTemplateItem {
  readonly label?: string;
  readonly role?: string;
  readonly type?: string;
  readonly checked?: boolean;
  readonly accelerator?: string;
  readonly click?: () => void;
  readonly submenu?: MenuTemplateItem[];
}

/**
 * Where the mocked `app.getPath` says Electron's per-application directories are.
 *
 * A path that exists on no machine, so a module that takes it to the real file system fails
 * loudly instead of writing into a developer's tree.
 */
const MOCK_APP_PATH_ROOT = "/sidekicks-electron-mock";

/** Where the mock says an installed app's resources folder is, on no machine, as above. */
const MOCK_RESOURCES_PATH = `${MOCK_APP_PATH_ROOT}/resources`;

/** The work area of the one display the mocked `screen` reports until a test sets others. */
const MOCK_PRIMARY_WORK_AREA: MockRectangle = { x: 0, y: 25, width: 1440, height: 875 };

/** What an `ipcMain.on` listener is handed: the asking frame, its page, and the sync answer. */
interface MockIpcMainEvent {
  readonly senderFrame: { readonly url: string };
  readonly sender: unknown;
  returnValue: unknown;
}

/** What an `app.on` listener is handed: the event whose default it may prevent. */
interface MockAppEvent {
  preventDefault(): void;
}

/** How to parameterize the mock. */
export interface ElectronMockOptions {
  /**
   * Record an ordered log of every mocked operation into `operations`.
   *
   * Off by default: a suite asserting shape does not want an ordering it did not ask for.
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
  readonly constructed: readonly MockBaseWindow[];
  /** Every view constructed since the last `reset()`, in order. */
  readonly constructedViews: readonly MockWebContentsView[];
  /** The mocked `nativeTheme`, whose `shouldUseDarkColors` follows `themeSource`. */
  readonly nativeTheme: { themeSource: string; readonly shouldUseDarkColors: boolean };
  /** The ordered operation log; empty unless `recordOrder` was set. */
  readonly operations: readonly string[];
  /** Every `app.exit(code)` code, in order. */
  readonly exitCodes: readonly number[];
  /** Every URL handed to `shell.openExternal`, in order. */
  readonly externalOpens: readonly string[];
  /** Every path handed to `shell.openPath`, in order. */
  readonly pathOpens: readonly string[];
  /** Every template handed to `Menu.setApplicationMenu`, in order. */
  readonly installedMenuTemplates: readonly MenuTemplateItem[][];
  /**
   * Every `ipcMain.handle` registration, by channel.
   *
   * The handlers themselves, not a count, because a suite over an IPC module drives the registered
   * function. A second registration for one channel throws, as Electron's does; a mock that
   * silently replaced it would hide that startup defect.
   */
  readonly ipcHandlers: ReadonlyMap<string, (event: unknown, ...args: never[]) => unknown>;
  /**
   * The `ipcMain.on` listeners, by channel: the synchronous channels. Each entry runs every
   * listener registered on its channel, as Electron's emitter does.
   */
  readonly ipcListeners: ReadonlyMap<string, (event: MockIpcMainEvent, ...args: never[]) => void>;

  /**
   * Appends `operation` to the ordered log when `recordOrder` was set, so a suite's own module
   * mocks land in the same sequence as Electron's operations.
   */
  record(operation: string): void;
  /** Clears every recording and restores the initial `packaged` value. */
  reset(): void;
  /** Sets `app.isPackaged` for the next module load. */
  setPackaged(packaged: boolean): void;
  /**
   * Fires every `app.on(eventName)` listener with an event, as Electron would emit it, and answers
   * whether a listener prevented its default.
   */
  emitAppEvent(eventName: string): boolean;
  /** Sets the displays' work areas the mocked `screen` answers from; the first is the primary. */
  setDisplayWorkAreas(workAreas: readonly MockRectangle[]): void;
  /** Sets whether the operating system is in its dark scheme, which `system` resolves to. */
  setSystemDark(isSystemDark: boolean): void;
  /**
   * Makes every `loadURL` whose URL contains `substring` reject with `error`.
   *
   * Substring so one call can fail the bundle load, the failure-document load, or both.
   */
  failLoadsContaining(substring: string, error: Error): void;
  /**
   * Makes `app.getPath(pathName)` throw `error` instead of answering.
   *
   * Electron's `getPath` throws when a path cannot be resolved, and the conditions that break a
   * startup (read-only home, revoked profile directory, full disk) break the lookup for the
   * directory the failure would be recorded in.
   */
  failPathLookup(pathName: string, error: Error): void;
  /**
   * Re-arms `app.whenReady()` with a fresh unresolved promise and clears the operation log.
   *
   * `whenReady` is a deferred the test resolves by hand: awaiting a dynamic `import()` drains
   * several microtask ticks, so a resolved promise would run the ready continuation before a test
   * could observe the module-evaluation-only prefix.
   */
  armReady(): void;
  /** Resolves the promise `app.whenReady()` returned. */
  releaseReady(): void;
}

/** The mock's own state and the `electron` module exports built over it. */
class ElectronMockImpl implements ElectronMock {
  public readonly moduleExports: Record<string, unknown>;
  public readonly constructed: MockBaseWindow[] = [];
  public readonly constructedViews: MockWebContentsView[] = [];
  public readonly nativeTheme: { themeSource: string; readonly shouldUseDarkColors: boolean };
  public readonly operations: string[] = [];
  public readonly exitCodes: number[] = [];
  public readonly externalOpens: string[] = [];
  public readonly pathOpens: string[] = [];
  public readonly installedMenuTemplates: MenuTemplateItem[][] = [];
  public readonly ipcHandlers = new Map<string, (event: unknown, ...args: never[]) => unknown>();
  public readonly ipcListeners = new Map<
    string,
    (event: MockIpcMainEvent, ...args: never[]) => void
  >();

  readonly #recordOrder: boolean;
  readonly #initialPackaged: boolean;
  readonly #loadFailures: { readonly substring: string; readonly error: Error }[] = [];
  readonly #pathLookupFailures = new Map<string, Error>();
  #packaged: boolean;
  #nextId = 1;
  readonly #openWindows: MockBaseWindow[] = [];
  readonly #appListeners = new Map<string, ((event: MockAppEvent) => void)[]>();
  readonly #themeListeners: (() => void)[] = [];
  #displayWorkAreas: readonly MockRectangle[] = [MOCK_PRIMARY_WORK_AREA];
  #isSystemDark = false;
  readonly #rendererListeners = new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>();
  readonly #ipcListenerLists = new Map<string, ((event: MockIpcMainEvent) => void)[]>();
  #releaseReady: () => void = () => {};
  #readyPromise: Promise<void>;

  public constructor(options: ElectronMockOptions) {
    // Electron sets `process.resourcesPath` before main runs, and plain Node leaves it unset.
    Object.defineProperty(process, "resourcesPath", {
      value: MOCK_RESOURCES_PATH,
      configurable: true,
    });
    this.#recordOrder = options.recordOrder ?? false;
    this.#initialPackaged = options.packaged ?? true;
    this.#packaged = this.#initialPackaged;
    this.#readyPromise = new Promise<void>((resolve) => {
      this.#releaseReady = resolve;
    });
    const isSystemDark = (): boolean => this.#isSystemDark;
    this.nativeTheme = {
      themeSource: "system",
      get shouldUseDarkColors(): boolean {
        return this.themeSource === "system" ? isSystemDark() : this.themeSource === "dark";
      },
    };
    this.moduleExports = this.#buildModuleExports();
  }

  /** Appends to the ordered log when the suite asked for one. */
  public record(operation: string): void {
    if (this.#recordOrder) {
      this.operations.push(operation);
    }
  }

  public recordConstruction(baseWindow: MockBaseWindow): void {
    this.constructed.push(baseWindow);
    this.#openWindows.push(baseWindow);
    this.record("construct");
  }

  public recordView(view: MockWebContentsView): void {
    this.constructedViews.push(view);
  }

  public forgetWindow(baseWindow: MockBaseWindow): void {
    this.#openWindows.splice(this.#openWindows.indexOf(baseWindow), 1);
  }

  public mintId(): number {
    return this.#nextId++;
  }

  public loadFailureFor(url: string): Error | undefined {
    return this.#loadFailures.find((failure) => url.includes(failure.substring))?.error;
  }

  public reset(): void {
    this.constructed.length = 0;
    this.constructedViews.length = 0;
    this.#openWindows.length = 0;
    this.#appListeners.clear();
    this.#themeListeners.length = 0;
    this.#displayWorkAreas = [MOCK_PRIMARY_WORK_AREA];
    this.#isSystemDark = false;
    this.nativeTheme.themeSource = "system";
    this.operations.length = 0;
    this.exitCodes.length = 0;
    this.externalOpens.length = 0;
    this.pathOpens.length = 0;
    this.installedMenuTemplates.length = 0;
    this.ipcHandlers.clear();
    this.ipcListeners.clear();
    this.#ipcListenerLists.clear();
    this.#rendererListeners.clear();
    this.#loadFailures.length = 0;
    this.#pathLookupFailures.clear();
    this.#nextId = 1;
    this.#packaged = this.#initialPackaged;
  }

  public setPackaged(packaged: boolean): void {
    this.#packaged = packaged;
  }

  public emitAppEvent(eventName: string): boolean {
    let isDefaultPrevented = false;
    const event: MockAppEvent = {
      preventDefault: () => {
        isDefaultPrevented = true;
      },
    };
    for (const listener of this.#appListeners.get(eventName) ?? []) {
      listener(event);
    }
    return isDefaultPrevented;
  }

  public setDisplayWorkAreas(workAreas: readonly MockRectangle[]): void {
    this.#displayWorkAreas = workAreas;
  }

  public setSystemDark(isSystemDark: boolean): void {
    this.#isSystemDark = isSystemDark;
    for (const listener of this.#themeListeners) {
      listener();
    }
  }

  public failLoadsContaining(substring: string, error: Error): void {
    this.#loadFailures.push({ substring, error });
  }

  public failPathLookup(pathName: string, error: Error): void {
    this.#pathLookupFailures.set(pathName, error);
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
    // Arrows rather than an aliased `this`: each closure reads the live field at call time, so
    // `setPackaged` and `armReady` are seen by a module that captured `app` at import time.
    const readPackaged = (): boolean => this.#packaged;
    const awaitReady = (): Promise<void> => {
      this.record("app.whenReady");
      return this.#readyPromise;
    };
    // The one page the mocked `ipcRenderer` speaks for. What main sends it reaches the listeners
    // the page registered, structured-cloned as Electron's IPC clones it. The page is never torn
    // down here, so main's own listeners on it are never called.
    const rendererPage = {
      id: 1,
      send: (channel: string, ...args: unknown[]): void => {
        for (const listener of this.#rendererListeners.get(channel) ?? []) {
          listener({}, ...structuredClone(args));
        }
      },
      isDestroyed: () => false,
      once: vi.fn(),
      on: vi.fn(),
    };
    const rendererEvent = (): MockIpcMainEvent => ({
      senderFrame: { url: INDEX_URL },
      sender: rendererPage,
      returnValue: undefined,
    });

    return {
      app: {
        get isPackaged(): boolean {
          return readPackaged();
        },
        requestSingleInstanceLock: vi.fn(() => {
          this.record("app.requestSingleInstanceLock");
          return true;
        }),
        whenReady: vi.fn(awaitReady),
        getPath: vi.fn((pathName: string) => {
          this.record(`app.getPath:${pathName}`);
          const failure = this.#pathLookupFailures.get(pathName);
          if (failure !== undefined) {
            throw failure;
          }
          return `${MOCK_APP_PATH_ROOT}/${pathName}`;
        }),
        // The build facts main reads after ready and hands every window. The name is the
        // package's `productName`, which Electron reads packaged or not.
        getName: vi.fn(() => "AI Sidekicks"),
        getVersion: vi.fn(() => "0.0.0"),
        getLocale: vi.fn(() => "en-US"),
        on: vi.fn((eventName: string, listener: (event: MockAppEvent) => void) => {
          this.record(`app.on:${eventName}`);
          this.#appListeners.set(eventName, [
            ...(this.#appListeners.get(eventName) ?? []),
            listener,
          ]);
        }),
        setAboutPanelOptions: vi.fn(),
        quit: vi.fn(() => {
          this.record("app.quit");
        }),
        exit: vi.fn((code: number) => {
          this.exitCodes.push(code);
          this.record(`app.exit:${String(code)}`);
        }),
      },
      crashReporter: {
        start: vi.fn(() => {
          this.record("crashReporter.start");
        }),
      },
      BaseWindow: createBoundBaseWindowClass(this, this.#openWindows),
      WebContentsView: createBoundWebContentsViewClass(this),
      screen: {
        getPrimaryDisplay: vi.fn(() => ({ workArea: this.#displayWorkAreas[0] })),
        // The display a rectangle overlaps most, or the primary when it overlaps none.
        getDisplayMatching: vi.fn((bounds: MockRectangle) => ({
          workArea: displayMatching(bounds, this.#displayWorkAreas),
        })),
      },
      nativeTheme: Object.assign(this.nativeTheme, {
        on: vi.fn((eventName: string, listener: () => void) => {
          if (eventName === "updated") {
            this.#themeListeners.push(listener);
          }
        }),
      }),
      Menu: {
        // Handed straight through: assertions read the template the module built; what Electron
        // renders is Electron's.
        buildFromTemplate: vi.fn((template: MenuTemplateItem[]) => template),
        setApplicationMenu: vi.fn((template: MenuTemplateItem[]) => {
          this.installedMenuTemplates.push(template);
          this.record("Menu.setApplicationMenu");
        }),
      },
      // The macOS menu-bar icon main builds at start, over an image that always reads.
      nativeImage: {
        createFromPath: vi.fn(() => ({ isEmpty: () => false })),
      },
      Tray: class {
        public on = vi.fn();
        public destroy = vi.fn();
      },
      shell: {
        openExternal: vi.fn((url: string) => {
          this.externalOpens.push(url);
          return Promise.resolve();
        }),
        // Electron answers an empty message for a path it opened.
        openPath: vi.fn((target: string) => {
          this.pathOpens.push(target);
          return Promise.resolve("");
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
      ipcMain: {
        handle: vi.fn((channel: string, handler: (event: unknown, ...args: never[]) => unknown) => {
          if (this.ipcHandlers.has(channel)) {
            // Electron's own behavior, kept: a second registration for one channel is a startup
            // defect a silent replace would hide.
            throw new Error(`Attempted to register a second handler for '${channel}'`);
          }
          this.ipcHandlers.set(channel, handler);
          this.record(`ipcMain.handle:${channel}`);
        }),
        on: vi.fn((channel: string, listener: (event: MockIpcMainEvent) => void) => {
          const listeners = [...(this.#ipcListenerLists.get(channel) ?? []), listener];
          this.#ipcListenerLists.set(channel, listeners);
          this.ipcListeners.set(channel, (event, ...args) => {
            for (const each of listeners) {
              (each as (event: MockIpcMainEvent, ...args: unknown[]) => void)(event, ...args);
            }
          });
        }),
      },
      // The page's side of IPC, answered by the handlers registered above. Arguments and answers
      // are structured-cloned, and a handler's error arrives as a new `Error` keeping only its
      // message, as Electron delivers it.
      ipcRenderer: {
        invoke: vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
          const handler = this.ipcHandlers.get(channel) as
            | ((event: MockIpcMainEvent, ...args: unknown[]) => unknown)
            | undefined;
          if (handler === undefined) {
            throw new Error(`No handler registered for '${channel}'`);
          }
          try {
            return structuredClone(await handler(rendererEvent(), ...structuredClone(args)));
          } catch (handlerError) {
            // eslint-disable-next-line preserve-caught-error -- Electron drops the cause in transit
            throw new Error(`Error invoking remote method '${channel}': ${String(handlerError)}`);
          }
        }),
        sendSync: vi.fn((channel: string, ...args: unknown[]): unknown => {
          const listener = this.ipcListeners.get(channel) as
            | ((event: MockIpcMainEvent, ...args: unknown[]) => void)
            | undefined;
          if (listener === undefined) {
            throw new Error(`No listener registered for '${channel}'`);
          }
          const event = rendererEvent();
          listener(event, ...structuredClone(args));
          return structuredClone(event.returnValue);
        }),
        on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
          this.#rendererListeners.set(channel, [
            ...(this.#rendererListeners.get(channel) ?? []),
            listener,
          ]);
        }),
      },
      net: { fetch: vi.fn() },
    };
  }
}

/**
 * Binds the window class to one mock instance.
 *
 * A factory because the `electron` module hands production code a constructor, which cannot close
 * over `this` through an arrow the way the other members do.
 */
function createBoundBaseWindowClass(
  mock: ElectronMockImpl,
  openWindows: readonly MockBaseWindow[],
): (new (options: MockBaseWindowOptions) => MockBaseWindow) & {
  getAllWindows(): MockBaseWindow[];
} {
  return class BoundBaseWindow extends MockBaseWindowImpl {
    public static getAllWindows(): MockBaseWindow[] {
      return [...openWindows];
    }

    public constructor(options: MockBaseWindowOptions) {
      super(mock, options);
    }
  };
}

/** Binds the view class to one mock instance, for the reason the window class is bound. */
function createBoundWebContentsViewClass(
  mock: ElectronMockImpl,
): new (options: MockWebContentsViewOptions) => MockWebContentsView {
  return class BoundWebContentsView extends MockWebContentsViewImpl {
    public constructor(options: MockWebContentsViewOptions) {
      super(mock, options);
    }
  };
}

/** The work area `bounds` overlaps most, or the first (the primary) when it overlaps none. */
function displayMatching(
  bounds: MockRectangle,
  workAreas: readonly MockRectangle[],
): MockRectangle | undefined {
  let best = workAreas[0];
  let bestOverlap = 0;
  for (const workArea of workAreas) {
    const overlapWidth =
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) -
      Math.max(bounds.x, workArea.x);
    const overlapHeight =
      Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
      Math.max(bounds.y, workArea.y);
    const overlap = Math.max(overlapWidth, 0) * Math.max(overlapHeight, 0);
    if (overlap > bestOverlap) {
      best = workArea;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * Builds one `electron` module mock.
 *
 * Call at the top level of a suite and hand `moduleExports` to `vi.mock`; the header says why the
 * instance must be a top-level `const` and the module under test imported dynamically.
 */
export function createElectronMock(options: ElectronMockOptions = {}): ElectronMock {
  return new ElectronMockImpl(options);
}
