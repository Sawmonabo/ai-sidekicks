// Window construction and the load ordering: the bundle loads over `sidekicks-renderer://` and
// the dev-server URL only under the two-condition dev branch (`!app.isPackaged` and
// `ELECTRON_RENDERER_URL` set), since a packaged build that inherited a stray variable would load
// remote content into a locked window; the factory routes through the locked `webPreferences` at
// runtime; and `beforeLoad` runs after the navigation policy and before `loadURL`, an order
// rather than two facts. `./window-navigation.test.ts` and `./window-load-failure.test.ts` own the
// rest. `electron` is mocked because a real `BrowserWindow` needs a running Electron process.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "@test/helpers/electron-mock.js";
import {
  asMockWindow,
  DEV_SERVER_URL,
  INDEX_URL,
  POLICY_OPERATIONS,
} from "@test/helpers/window-test-harness.js";

// `recordOrder` is on because the ordering cases assert a sequence across operations.
const electronMock = createElectronMock({ recordOrder: true });

vi.mock("electron", () => electronMock.moduleExports);

type WindowModule = typeof import("./window.js");

/** Re-imports `window.ts` so each case observes a clean construction log. */
async function loadWindowModule(): Promise<WindowModule> {
  vi.resetModules();
  return import("./window.js");
}

describe("the main window factory", () => {
  beforeEach(() => {
    electronMock.reset();
    delete process.env["ELECTRON_RENDERER_URL"];
  });

  afterEach(() => {
    delete process.env["ELECTRON_RENDERER_URL"];
    vi.restoreAllMocks();
  });

  describe("the document URL", () => {
    it("loads the bundle over the renderer scheme in a packaged build", async () => {
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow).loadedUrls).toEqual([INDEX_URL]);
    });

    it("loads the dev-server URL only when unpackaged AND the variable is set", async () => {
      electronMock.setPackaged(false);
      process.env["ELECTRON_RENDERER_URL"] = DEV_SERVER_URL;
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow).loadedUrls).toEqual([DEV_SERVER_URL]);
    });

    // The load-bearing half: a packaged binary that inherited the variable must refuse it.
    it("refuses the dev-server URL when packaged even though the variable is set", async () => {
      electronMock.setPackaged(true);
      process.env["ELECTRON_RENDERER_URL"] = DEV_SERVER_URL;
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow)).toBeDefined();
      expect(asMockWindow(browserWindow).loadedUrls).toEqual([INDEX_URL]);
    });

    it("refuses the dev-server URL when unpackaged and the variable is unset", async () => {
      electronMock.setPackaged(false);
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();

      expect(asMockWindow(browserWindow).loadedUrls).toEqual([INDEX_URL]);
    });
  });

  it("constructs the window through the locked webPreferences block", async () => {
    const { createMainWindow } = await loadWindowModule();

    createMainWindow();

    const options = electronMock.constructed[0]?.options;
    // At runtime as well as build time: this reads what reached Electron.
    expect(options?.webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
    });
    expect(options?.webPreferences["preload"]).toEqual(expect.stringContaining("preload"));
  });

  // The load starts inside the factory; `beforeLoad` makes the listener ordering structural and
  // these cases stop it regressing to the timing-dependent shape.
  describe("beforeLoad runs before the load starts", () => {
    it("invokes the hook, with the window, ahead of loadURL", async () => {
      const { createMainWindow } = await loadWindowModule();

      let windowSeenByHook: unknown;
      const browserWindow = createMainWindow({
        beforeLoad: (window) => {
          windowSeenByHook = window;
          window.webContents.once("did-finish-load", () => {});
        },
      });

      expect(windowSeenByHook).toBe(browserWindow);
      // The assertion is the order; both happening would pass on the regression.
      expect(electronMock.operations).toEqual([
        "construct",
        ...POLICY_OPERATIONS,
        "webContents.once:did-finish-load",
        `loadURL:${INDEX_URL}`,
      ]);
    });

    it("destroys the window and rethrows when the hook throws", async () => {
      const { createMainWindow } = await loadWindowModule();

      const hookFailure = new Error("listener registration failed");

      expect(() =>
        createMainWindow({
          beforeLoad: () => {
            throw hookFailure;
          },
        }),
      ).toThrow(hookFailure);

      // No load and nothing left alive: no blank, unloaded window is left behind.
      expect(electronMock.operations).toEqual(["construct", ...POLICY_OPERATIONS, "destroy"]);
      expect(electronMock.constructed).toHaveLength(1);
      expect(electronMock.constructed[0]?.isDestroyed()).toBe(true);
    });
  });
});
