// Window construction and the load ordering: the bundle loads over `sidekicks-renderer://` and
// the dev-server URL only under the two-condition dev branch (`!app.isPackaged` and
// `ELECTRON_RENDERER_URL` set), since a packaged build that inherited a stray variable would load
// remote content into a locked window; the factory routes through the locked `webPreferences` at
// runtime; `beforeLoad` runs after the window's own listeners and before `loadURL`, an order
// rather than two facts; the hidden window stays unshown and unthrottled, and a window a person
// sees is revealed as it is built; the window takes its document's title; and the window and its
// document close together, from either side.
// `./factory.navigation.test.ts` and `./load-failure/recovery.test.ts` own the rest. `electron` is
// mocked because a real `BaseWindow` needs a running Electron process.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "#test/helpers/electron/mock/module.js";
import {
  asMockWindow,
  DEV_SERVER_URL,
  handedDocument,
  INDEX_URL,
  testWindowFrame,
} from "#test/helpers/electron/mock/readers.js";

// `recordOrder` is on because the ordering cases assert a sequence across operations.
const electronMock = createElectronMock({ recordOrder: true });

vi.mock("electron", () => electronMock.moduleExports);

/**
 * What every locked window's document carries, in the order `constructLockedWindow` installs it:
 * the navigation policy, then the close pairing and the title mirror. Named once so the ordering
 * cases read as these, then the caller's hook, then the load, and a new seam fails all of them at
 * once.
 */
const LOCKED_WINDOW_OPERATIONS: readonly string[] = [
  "webContents.on:will-navigate",
  "webContents.on:will-redirect",
  "webContents.setWindowOpenHandler",
  "webContents.once:destroyed",
  "webContents.on:page-title-updated",
];

type WindowModule = typeof import("./factory.js");

/** Re-imports `factory.ts` so each case observes a clean construction log. */
async function loadWindowModule(): Promise<WindowModule> {
  vi.resetModules();
  return import("./factory.js");
}

/** Opens the hidden window with the test frame and no switches. */
async function openTestWindow(
  beforeLoad?: Parameters<WindowModule["openHiddenWindow"]>[0]["beforeLoad"],
): Promise<ReturnType<WindowModule["openHiddenWindow"]>> {
  const { openHiddenWindow } = await loadWindowModule();
  return openHiddenWindow({
    ...testWindowFrame(),
    additionalArguments: [],
    ...(beforeLoad === undefined ? {} : { beforeLoad }),
  });
}

describe("the window factory", () => {
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
      const rendererWindow = await openTestWindow();

      expect(asMockWindow(rendererWindow).document.loadedUrls).toEqual([INDEX_URL]);
    });

    it("loads the dev-server URL only when unpackaged AND the variable is set", async () => {
      electronMock.setPackaged(false);
      process.env["ELECTRON_RENDERER_URL"] = DEV_SERVER_URL;

      const rendererWindow = await openTestWindow();

      expect(asMockWindow(rendererWindow).document.loadedUrls).toEqual([
        new URL(DEV_SERVER_URL).href,
      ]);
    });

    // The load-bearing half: a packaged binary that inherited the variable must refuse it.
    it("refuses the dev-server URL when packaged even though the variable is set", async () => {
      electronMock.setPackaged(true);
      process.env["ELECTRON_RENDERER_URL"] = DEV_SERVER_URL;

      const rendererWindow = await openTestWindow();

      expect(asMockWindow(rendererWindow).document.loadedUrls).toEqual([INDEX_URL]);
    });

    it("refuses the dev-server URL when unpackaged and the variable is unset", async () => {
      electronMock.setPackaged(false);

      const rendererWindow = await openTestWindow();

      expect(asMockWindow(rendererWindow).document.loadedUrls).toEqual([INDEX_URL]);
    });
  });

  it("constructs the view through the locked webPreferences block", async () => {
    await openTestWindow();

    const webPreferences = electronMock.constructedViews[0]?.options.webPreferences;
    // At runtime as well as build time: this reads what reached Electron.
    expect(webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
    });
    expect(webPreferences?.["preload"]).toEqual(expect.stringContaining("preload"));
  });

  // The load starts inside the factory; `beforeLoad` makes the listener ordering structural and
  // these cases stop it regressing to the timing-dependent shape.
  describe("beforeLoad runs before the load starts", () => {
    it("invokes the hook, with the window, ahead of loadURL", async () => {
      let windowSeenByHook: unknown;
      const rendererWindow = await openTestWindow((window) => {
        windowSeenByHook = window;
        window.view.webContents.once("dom-ready", () => {});
      });

      expect(windowSeenByHook).toBe(rendererWindow);
      // The assertion is the order; both happening would pass on the regression.
      expect(electronMock.operations).toEqual([
        "construct",
        ...LOCKED_WINDOW_OPERATIONS,
        "webContents.once:dom-ready",
        `loadURL:${INDEX_URL}`,
      ]);
    });

    it("destroys the window, its document with it, and rethrows when the hook throws", async () => {
      const hookFailure = new Error("listener registration failed");

      await expect(
        openTestWindow(() => {
          throw hookFailure;
        }),
      ).rejects.toThrow(hookFailure);

      // No load and nothing left alive: no blank, unloaded window is left behind.
      expect(electronMock.operations.at(-1)).toBe("destroy");
      expect(electronMock.operations.some((operation) => operation.startsWith("loadURL"))).toBe(
        false,
      );
      expect(electronMock.constructed[0]?.isDestroyed()).toBe(true);
      expect(electronMock.constructedViews[0]?.webContents.isDestroyed()).toBe(true);
    });
  });

  it("keeps the hidden window unshown and unthrottled, and reveals a window a person sees", async () => {
    const hiddenWindow = asMockWindow(await openTestWindow());
    hiddenWindow.document.emit("did-finish-load");

    expect(hiddenWindow.baseWindow.showCount).toBe(0);
    // Its document draws every window a person sees, so its timers never slow.
    expect(hiddenWindow.document.setBackgroundThrottling).toHaveBeenCalledWith(false);

    const { adoptRendererChild } = await import("./factory.js");
    const child = adoptRendererChild(testWindowFrame(), handedDocument() as never);
    expect(asMockWindow(child).baseWindow.showCount).toBe(1);
  });

  it("takes the title its document sets, which the Window menu and the taskbar show", async () => {
    const { baseWindow, document } = asMockWindow(await openTestWindow());

    document.emit("page-title-updated", {}, "Fix the parser — ai-sidekicks");

    expect(baseWindow.title).toBe("Fix the parser — ai-sidekicks");
  });

  describe("the window and its document close together", () => {
    it("closes the document when the window closes", async () => {
      const { baseWindow, document } = asMockWindow(await openTestWindow());

      baseWindow.close();

      expect(document.isDestroyed()).toBe(true);
    });

    it("closes the window when its document goes, as a page's own close does", async () => {
      const { baseWindow, document } = asMockWindow(await openTestWindow());

      document.close();

      expect(baseWindow.isDestroyed()).toBe(true);
    });
  });
});
