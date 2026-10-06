// The rejected-load recovery ladder, including the two rungs that decide whether the process
// survives: giving up when even the failure document cannot be served (destroy, and exit
// non-zero), and the rung that must not give up, a window the user closed while its load was
// failing. That is an ordinary quit, and `app.exit` would skip `before-quit` and `will-quit`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "#test/helpers/electron/mock/electron-mock.js";
import {
  asMockWindow,
  INDEX_URL,
  loggedMessages,
  testWindowFrame,
} from "#test/helpers/window-test-harness.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

type WindowModule = typeof import("../factory.js");
type LoadFailureModule = typeof import("./recovery.js");

async function loadWindowModule(): Promise<WindowModule> {
  vi.resetModules();
  return import("../factory.js");
}

/** Both modules from one reset, so the exit code read is the one that was used. */
async function loadWindowAndFailureModules(): Promise<{
  windowModule: WindowModule;
  loadFailureModule: LoadFailureModule;
}> {
  vi.resetModules();
  return {
    windowModule: await import("../factory.js"),
    loadFailureModule: await import("./recovery.js"),
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

  it("serves the generated failure document carrying the reason, and shows it", async () => {
    electronMock.failLoadsContaining(INDEX_URL, new Error("ERR_FILE_NOT_FOUND (-6)"));
    const { openHiddenWindow } = await loadWindowModule();
    const frame = testWindowFrame();

    const rendererWindow = openHiddenWindow({ ...frame, additionalArguments: [] });

    await vi.waitFor(() => {
      expect(asMockWindow(rendererWindow).document.loadedUrls).toHaveLength(2);
    });
    const [, failureUrl] = asMockWindow(rendererWindow).document.loadedUrls;
    expect(failureUrl).toContain("/-/load-failure");
    expect(failureUrl).toContain(encodeURIComponent("ERR_FILE_NOT_FOUND (-6)"));
    expect(rendererWindow.baseWindow.isDestroyed()).toBe(false);
    // The hidden window is never shown, but the failure is: a person would see nothing else.
    await vi.waitFor(() => {
      expect(asMockWindow(rendererWindow).baseWindow.showCount).toBe(1);
    });
    expect(electronMock.exitCodes).toEqual([]);
    expect(loggedMessages(frame.log)).toEqual([
      expect.stringContaining("failed to load sidekicks-renderer://app/index.html"),
    ]);
  });

  it("destroys the hidden window and exits non-zero when no document can be served", async () => {
    electronMock.failLoadsContaining("sidekicks-renderer://app", new Error("handler missing"));
    const { windowModule, loadFailureModule } = await loadWindowAndFailureModules();
    const frame = testWindowFrame();
    let exitsWhenTheLogDrained: number | undefined;
    frame.log.drain.mockImplementation(() => {
      exitsWhenTheLogDrained = electronMock.exitCodes.length;
      return Promise.resolve();
    });

    const rendererWindow = windowModule.openHiddenWindow({ ...frame, additionalArguments: [] });

    await vi.waitFor(() => {
      expect(electronMock.exitCodes).toEqual([loadFailureModule.RENDERER_UNSERVABLE_EXIT_CODE]);
    });
    expect(rendererWindow.baseWindow.isDestroyed()).toBe(true);
    // The reason reaches the log, and the log is drained before the exit, which a queued append
    // would not survive.
    expect(loggedMessages(frame.log).join(" ")).toContain("no renderer document");
    expect(exitsWhenTheLogDrained).toBe(0);
  });

  it("gives up the same way when the failure document loads but cannot be shown", async () => {
    electronMock.failLoadsContaining(INDEX_URL, new Error("ERR_FILE_NOT_FOUND (-6)"));
    const { windowModule, loadFailureModule } = await loadWindowAndFailureModules();
    const frame = testWindowFrame();

    const rendererWindow = windowModule.openHiddenWindow({ ...frame, additionalArguments: [] });
    vi.spyOn(rendererWindow.baseWindow, "show").mockImplementation(() => {
      throw new TypeError("Object has been destroyed");
    });

    await vi.waitFor(() => {
      expect(electronMock.exitCodes).toEqual([loadFailureModule.RENDERER_UNSERVABLE_EXIT_CODE]);
    });
    expect(loggedMessages(frame.log).join(" ")).toContain(
      "the load-failure document could not be shown: Object has been destroyed",
    );
  });

  // The ordinary case, which must not reach `app.exit`: the window is destroyed right after the
  // factory returns, so the rejection handler runs against a window that is gone.
  describe("a window closed while its load was failing", () => {
    it("serves no document, and does not exit the process", async () => {
      electronMock.failLoadsContaining(INDEX_URL, new Error("ERR_ABORTED (-3)"));
      const { openHiddenWindow } = await loadWindowModule();
      const frame = testWindowFrame();

      const rendererWindow = openHiddenWindow({ ...frame, additionalArguments: [] });
      // Synchronous: `loadURL`'s rejection arrives on a later microtask.
      rendererWindow.baseWindow.destroy();

      await vi.waitFor(() => {
        expect(loggedMessages(frame.log).join(" ")).toContain("closed while its load was failing");
      });

      // `app.exit` skips `before-quit` and `will-quit`, so an exit here would bypass the drain.
      expect(electronMock.exitCodes).toEqual([]);
      // No second load: there is no window left to show one in.
      expect(asMockWindow(rendererWindow).document.loadedUrls).toEqual([INDEX_URL]);
      // The give-up diagnostic must not appear: the window went away, it was not unservable.
      expect(loggedMessages(frame.log).join(" ")).not.toContain("no renderer document");
    });
  });
});
