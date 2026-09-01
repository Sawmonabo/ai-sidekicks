// Plan-023 Phase 1B (T-023p-1B-2) — the window factories.
//
// Three properties are asserted here that nothing else in the suite reaches:
//
//   1. The main window loads the bundle over `sidekicks-renderer://`, and the
//      dev-server URL is loaded ONLY under the two-condition dev branch
//      (`!app.isPackaged` AND `ELECTRON_RENDERER_URL` set). A packaged build
//      that inherited a stray `ELECTRON_RENDERER_URL` from its parent shell
//      would otherwise load whatever that variable pointed at — remote content
//      inside a window whose `webPreferences` were locked down precisely so
//      that could not happen (Plan-023 I-023-2).
//   2. Every window — main and auxiliary — is constructed with the SAME locked
//      `webPreferences` block. `assert-webprefs.ts` proves the literal is
//      correct and appears exactly once in the source; this proves the second
//      factory actually routes through it at runtime (Plan-023 I-023-12).
//   3. Two auxiliary windows share no object identity: distinct `webContents`,
//      distinct ids, and neither holding the main window's. That is the
//      runtime half of "its own bridge instance and no shared store" — the
//      preload path is per-window by construction, and this proves the
//      factory does not hand back a cached window (Plan-023 I-023-12).
//
// The `electron` module is mocked because a real `BrowserWindow` needs a
// running Electron process; these are `main-unit` tests (node environment, the
// project T-023p-1B-3 registers), not the smoke suite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => {
  interface ConstructedWindow {
    readonly options: {
      readonly width: number;
      readonly height: number;
      readonly show: boolean;
      readonly webPreferences: Record<string, unknown>;
    };
    readonly id: number;
    readonly webContents: { readonly id: number };
    readonly loadedUrls: string[];
  }

  const constructed: ConstructedWindow[] = [];
  let nextWindowId = 1;
  let isPackaged = true;

  return {
    constructed,
    reset(): void {
      constructed.length = 0;
      nextWindowId = 1;
      isPackaged = true;
    },
    setPackaged(value: boolean): void {
      isPackaged = value;
    },
    get isPackaged(): boolean {
      return isPackaged;
    },
    mintWindowId(): number {
      return nextWindowId++;
    },
  };
});

vi.mock("electron", () => {
  class MockBrowserWindow {
    public readonly id: number;
    public readonly webContents: {
      id: number;
      on: ReturnType<typeof vi.fn>;
      handlers: Map<string, (...args: unknown[]) => void>;
    };
    public readonly loadedUrls: string[] = [];
    public readonly onceHandlers = new Map<string, () => void>();
    private destroyed = false;

    public constructor(
      public readonly options: {
        width: number;
        height: number;
        show: boolean;
        webPreferences: Record<string, unknown>;
      },
    ) {
      this.id = electronMock.mintWindowId();
      const webContentsHandlers = new Map<string, (...args: unknown[]) => void>();
      this.webContents = {
        id: this.id * 1000,
        handlers: webContentsHandlers,
        on: vi.fn((eventName: string, handler: (...args: unknown[]) => void) => {
          webContentsHandlers.set(eventName, handler);
        }),
      };
      electronMock.constructed.push(this as never);
    }

    public once(eventName: string, handler: () => void): this {
      this.onceHandlers.set(eventName, handler);
      return this;
    }

    public show(): void {}

    public isDestroyed(): boolean {
      return this.destroyed;
    }

    public destroy(): void {
      this.destroyed = true;
    }

    public loadURL(url: string): Promise<void> {
      this.loadedUrls.push(url);
      return Promise.resolve();
    }
  }

  return {
    app: {
      get isPackaged(): boolean {
        return electronMock.isPackaged;
      },
    },
    BrowserWindow: MockBrowserWindow,
  };
});

type WindowModule = typeof import("./window.js");

/** Re-imports `window.ts` so each case observes a clean construction log. */
async function loadWindowModule(): Promise<WindowModule> {
  vi.resetModules();
  return import("./window.js");
}

const DEV_SERVER_URL = "http://localhost:5173";

describe("window factories", () => {
  beforeEach(() => {
    electronMock.reset();
    delete process.env["ELECTRON_RENDERER_URL"];
  });

  afterEach(() => {
    delete process.env["ELECTRON_RENDERER_URL"];
    vi.restoreAllMocks();
  });

  describe("the main window's document URL", () => {
    it("loads the bundle over the renderer scheme in a packaged build", async () => {
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect((browserWindow as unknown as { loadedUrls: string[] }).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html",
      ]);
    });

    it("loads the dev-server URL only when unpackaged AND the variable is set", async () => {
      electronMock.setPackaged(false);
      process.env["ELECTRON_RENDERER_URL"] = DEV_SERVER_URL;
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect((browserWindow as unknown as { loadedUrls: string[] }).loadedUrls).toEqual([
        DEV_SERVER_URL,
      ]);
    });

    // The load-bearing half: a packaged binary that inherited the variable
    // must still refuse it. This is the arm that would ship remote content
    // into a hardened window if the condition were an OR.
    it("refuses the dev-server URL when packaged even though the variable is set", async () => {
      electronMock.setPackaged(true);
      process.env["ELECTRON_RENDERER_URL"] = DEV_SERVER_URL;
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(browserWindow as unknown as { loadedUrls: string[] }).toBeDefined();
      expect((browserWindow as unknown as { loadedUrls: string[] }).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html",
      ]);
    });

    it("refuses the dev-server URL when unpackaged and the variable is unset", async () => {
      electronMock.setPackaged(false);
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect((browserWindow as unknown as { loadedUrls: string[] }).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html",
      ]);
    });

    // An empty string is a set-but-meaningless variable; treating it as set
    // would produce `loadURL("#/window/timeline")`, which is not a URL at all.
    it("refuses the dev-server URL when the variable is set to an empty string", async () => {
      electronMock.setPackaged(false);
      process.env["ELECTRON_RENDERER_URL"] = "";
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect((browserWindow as unknown as { loadedUrls: string[] }).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html",
      ]);
    });
  });

  describe("auxiliary windows", () => {
    it("routes both auxiliary routes to distinct window fragments", async () => {
      const { createAuxiliaryWindow } = await loadWindowModule();

      const timelineWindow = createAuxiliaryWindow("timeline");
      const agentConsoleWindow = createAuxiliaryWindow("agent-console");

      expect((timelineWindow as unknown as { loadedUrls: string[] }).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html#/window/timeline",
      ]);
      expect((agentConsoleWindow as unknown as { loadedUrls: string[] }).loadedUrls).toEqual([
        "sidekicks-renderer://app/index.html#/window/agent-console",
      ]);
    });

    it("constructs every window through the one locked webPreferences block", async () => {
      const { createMainWindow, createAuxiliaryWindow } = await loadWindowModule();

      createMainWindow();
      createAuxiliaryWindow("timeline");
      createAuxiliaryWindow("agent-console");

      const [mainOptions, ...auxiliaryOptions] = electronMock.constructed.map(
        (browserWindow) => browserWindow.options,
      );
      expect(mainOptions).toBeDefined();
      expect(auxiliaryOptions).toHaveLength(2);

      // Deep equality, not a subset check: an auxiliary window that ADDED a
      // key (say `webviewTag: true`) would pass a subset check and still be a
      // hole in the hardening baseline.
      for (const options of auxiliaryOptions) {
        expect(options.webPreferences).toEqual(mainOptions?.webPreferences);
      }

      // ...and the block is the Spec-023 §Security Hardening Baseline one,
      // asserted here at runtime as well as at build time.
      expect(mainOptions?.webPreferences).toMatchObject({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
      });
      expect(mainOptions?.webPreferences["preload"]).toEqual(expect.stringContaining("preload"));
    });

    it("hands back windows that share no identity with each other or the main window", async () => {
      const { createMainWindow, createAuxiliaryWindow } = await loadWindowModule();

      const mainBrowserWindow = createMainWindow();
      const firstAuxiliary = createAuxiliaryWindow("timeline");
      const secondAuxiliary = createAuxiliaryWindow("agent-console");

      const identifiers = [mainBrowserWindow.id, firstAuxiliary.id, secondAuxiliary.id];
      expect(new Set(identifiers).size).toBe(3);

      const webContentsIdentifiers = [
        mainBrowserWindow.webContents.id,
        firstAuxiliary.webContents.id,
        secondAuxiliary.webContents.id,
      ];
      expect(new Set(webContentsIdentifiers).size).toBe(3);
      expect(firstAuxiliary.webContents).not.toBe(secondAuxiliary.webContents);
      expect(firstAuxiliary.webContents).not.toBe(mainBrowserWindow.webContents);
    });

    it("destroys an auxiliary window whose renderer process is gone", async () => {
      const { createAuxiliaryWindow } = await loadWindowModule();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const auxiliaryWindow = createAuxiliaryWindow("timeline");
      const rendererGoneHandler = (
        auxiliaryWindow.webContents as unknown as {
          handlers: Map<string, (...args: unknown[]) => void>;
        }
      ).handlers.get("render-process-gone");
      expect(rendererGoneHandler).toBeDefined();

      rendererGoneHandler?.({}, { reason: "crashed", exitCode: 133 });

      expect(auxiliaryWindow.isDestroyed()).toBe(true);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]?.[0]).toContain("route=timeline");
      expect(consoleError.mock.calls[0]?.[0]).toContain("reason=crashed");
    });

    // The main window deliberately carries NO `render-process-gone` handler:
    // destroying it would fire `window-all-closed` and quit the application
    // out from under the user. Main-window crash handling is the Tier-8 crash
    // reporter's (T-023r-3-2), not this factory's.
    it("does not register a renderer-gone handler on the main window", async () => {
      const { createMainWindow } = await loadWindowModule();

      const mainBrowserWindow = createMainWindow();

      expect(
        (
          mainBrowserWindow.webContents as unknown as {
            handlers: Map<string, unknown>;
          }
        ).handlers.size,
      ).toBe(0);
    });
  });

  it("shows a window only once its first paint is ready", async () => {
    const { createMainWindow } = await loadWindowModule();

    const mainBrowserWindow = createMainWindow() as unknown as {
      readonly options: { readonly show: boolean };
      readonly onceHandlers: Map<string, () => void>;
    };
    const readyToShow = mainBrowserWindow.onceHandlers.get("ready-to-show");

    expect(mainBrowserWindow.options.show).toBe(false);
    expect(readyToShow).toBeDefined();
  });
});
