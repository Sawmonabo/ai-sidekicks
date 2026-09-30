// The rejected-load recovery ladder, including the two rungs that decide whether the process
// survives: giving up when even the failure document cannot be served (destroy, and for the
// main window exit non-zero), and the rung that must not give up, a window the user closed while
// its load was failing. That is an ordinary quit, and `app.exit` would skip `before-quit` and
// `will-quit`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "@test/helpers/electron-mock.js";
import { asMockWindow, INDEX_URL } from "@test/helpers/window-test-harness.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

type WindowModule = typeof import("./window.js");
type LoadFailureModule = typeof import("./window-load-failure.js");

async function loadWindowModule(): Promise<WindowModule> {
  vi.resetModules();
  return import("./window.js");
}

/** Both modules from one reset, so the exit code read is the one that was used. */
async function loadWindowAndFailureModules(): Promise<{
  windowModule: WindowModule;
  loadFailureModule: LoadFailureModule;
}> {
  vi.resetModules();
  return {
    windowModule: await import("./window.js"),
    loadFailureModule: await import("./window-load-failure.js"),
  };
}

describe("a rejected document load", () => {
  beforeEach(() => {
    electronMock.reset();
    delete process.env["ELECTRON_RENDERER_URL"];
  });

  afterEach(() => {
    delete process.env["ELECTRON_RENDERER_URL"];
    vi.restoreAllMocks();
  });

  it("serves the generated failure document carrying the reason", async () => {
    electronMock.failLoadsContaining(INDEX_URL, new Error("ERR_FILE_NOT_FOUND (-6)"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { createMainWindow } = await loadWindowModule();

    const browserWindow = createMainWindow();

    await vi.waitFor(() => {
      expect(asMockWindow(browserWindow).loadedUrls).toHaveLength(2);
    });
    const [, failureUrl] = asMockWindow(browserWindow).loadedUrls;
    expect(failureUrl).toContain("/-/load-failure");
    expect(failureUrl).toContain(encodeURIComponent("ERR_FILE_NOT_FOUND (-6)"));
    expect(browserWindow.isDestroyed()).toBe(false);
    expect(electronMock.exitCodes).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
  });

  it("destroys the main window and exits non-zero when no document can be served", async () => {
    electronMock.failLoadsContaining("sidekicks-renderer://app", new Error("handler missing"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { windowModule, loadFailureModule } = await loadWindowAndFailureModules();

    const browserWindow = windowModule.createMainWindow();

    await vi.waitFor(() => {
      expect(electronMock.exitCodes).toEqual([loadFailureModule.RENDERER_UNSERVABLE_EXIT_CODE]);
    });
    expect(browserWindow.isDestroyed()).toBe(true);
    expect(consoleError.mock.calls.flat().join(" ")).toContain("no renderer document");
  });

  // The ordinary case, which must not reach `app.exit`: the window is destroyed right after the
  // factory returns, so the rejection handler runs against a window that is gone.
  describe("a window closed while its load was failing", () => {
    it("serves no document, and does not exit the process", async () => {
      electronMock.failLoadsContaining(INDEX_URL, new Error("ERR_ABORTED (-3)"));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();
      // Synchronous: `loadURL`'s rejection arrives on a later microtask.
      browserWindow.destroy();

      await vi.waitFor(() => {
        expect(consoleWarn).toHaveBeenCalled();
      });

      // `app.exit` skips `before-quit` and `will-quit`, so an exit here would bypass the drain.
      expect(electronMock.exitCodes).toEqual([]);
      // No second load: there is no window left to show one in.
      expect(asMockWindow(browserWindow).loadedUrls).toEqual([INDEX_URL]);
      expect(consoleWarn.mock.calls.flat().join(" ")).toContain(
        "closed while its load was failing",
      );
      // The give-up diagnostic must not appear: the window went away, it was not unservable.
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain("no renderer document");
    });
  });
});
