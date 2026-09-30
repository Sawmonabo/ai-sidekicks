// The one `electron` module mock.
//
// One factory, parameterized, so main-process suites do not each hand-roll a `vi.mock("electron")`
// factory and drift apart. `recordOrder` turns on the ordered operation log (a suite asserting
// sequence needs it; one asserting shape does not want the noise), and `packaged` sets the initial
// `app.isPackaged`. Everything else (windows constructed, URLs loaded, externals opened, menu
// templates installed) is always recorded.
//
// Usage: the mock instance must exist before the `vi.mock` factory runs, not before it is
// registered. `vi.mock` is hoisted, but its factory runs lazily when the module under test first
// imports `electron`, so the working shape is a top-level `const` plus a dynamic import:
//
//     const electronMock = createElectronMock({ recordOrder: true });
//     vi.mock("electron", () => electronMock.moduleExports);
//     // …then, inside a test: await import("./window.js")
//
// A suite that statically imports the module under test cannot use this shape: the static import
// evaluates before the `const` initializes, so the factory would read a binding in its temporal
// dead zone. Such a suite keeps a local factory (`src/main/services/renderer-protocol.test.ts`).
//
// The reading helpers the window suites share live in `./window-test-harness.ts`.

import { vi } from "vitest";

import {
  MockBrowserWindowImpl,
  type MockBrowserWindow,
  type MockBrowserWindowOptions,
} from "./electron-mock-window.js";

// Republished so a suite that reads a constructed window need not know this module is two files.
// Only the window itself: the options and `webContents` are reached through it, and a re-export of
// each would be an unused export.
export type { MockBrowserWindow } from "./electron-mock-window.js";

/**
 * One entry of a `Menu.buildFromTemplate` template, as a test reads it.
 *
 * Declared here so menu assertions agree on the shape.
 */
export interface MenuTemplateItem {
  readonly label?: string;
  readonly role?: string;
  readonly type?: string;
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
  readonly constructed: readonly MockBrowserWindow[];
  /** The ordered operation log; empty unless `recordOrder` was set. */
  readonly operations: readonly string[];
  /** Every `app.exit(code)` code, in order. */
  readonly exitCodes: readonly number[];
  /** Every URL handed to `shell.openExternal`, in order. */
  readonly externalOpens: readonly string[];
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

  /** Clears every recording and restores the initial `packaged` value. */
  reset(): void;
  /** Sets `app.isPackaged` for the next module load. */
  setPackaged(packaged: boolean): void;
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
  public readonly constructed: MockBrowserWindow[] = [];
  public readonly operations: string[] = [];
  public readonly exitCodes: number[] = [];
  public readonly externalOpens: string[] = [];
  public readonly installedMenuTemplates: MenuTemplateItem[][] = [];
  public readonly ipcHandlers = new Map<string, (event: unknown, ...args: never[]) => unknown>();

  readonly #recordOrder: boolean;
  readonly #initialPackaged: boolean;
  readonly #loadFailures: { readonly substring: string; readonly error: Error }[] = [];
  readonly #pathLookupFailures = new Map<string, Error>();
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
    this.ipcHandlers.clear();
    this.#loadFailures.length = 0;
    this.#pathLookupFailures.clear();
    this.#nextWindowId = 1;
    this.#packaged = this.#initialPackaged;
  }

  public setPackaged(packaged: boolean): void {
    this.#packaged = packaged;
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

    return {
      app: {
        get isPackaged(): boolean {
          return readPackaged();
        },
        requestSingleInstanceLock: vi.fn(() => true),
        whenReady: vi.fn(awaitReady),
        getPath: vi.fn((pathName: string) => {
          this.record(`app.getPath:${pathName}`);
          const failure = this.#pathLookupFailures.get(pathName);
          if (failure !== undefined) {
            throw failure;
          }
          return `${MOCK_APP_PATH_ROOT}/${pathName}`;
        }),
        // The build facts main reads after ready and hands every window.
        getVersion: vi.fn(() => "0.0.0"),
        getLocale: vi.fn(() => "en-US"),
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
        // Handed straight through: assertions read the template the module built; what Electron
        // renders is Electron's.
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
 * Call at the top level of a suite and hand `moduleExports` to `vi.mock`; the header says why the
 * instance must be a top-level `const` and the module under test imported dynamically.
 */
export function createElectronMock(options: ElectronMockOptions = {}): ElectronMock {
  return new ElectronMockImpl(options);
}
