// Plan-023 Phase 1B (T-023p-1B-2) — the rejected-load recovery ladder.
//
// A rejected `loadURL` used to log and return, leaving a live blank window with
// no content and no reason. Every rung of the replacement is asserted here,
// including the two that decide whether the PROCESS survives:
//
//   • the generated failure document, served in place of the blank window;
//   • giving up when even that cannot be served — destroy, and for the main
//     window exit non-zero rather than sit there as an invisible placeholder;
//   • and the rung that must NOT give up: a window the user closed while its
//     load was still failing. That is an ordinary quit, and treating it as an
//     unservable renderer would call `app.exit` — which runs no `before-quit`
//     and no `will-quit` handler, so the sidecar would never be drained and a
//     normal close would report exit 5.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "../../test/helpers/electron-mock.js";
import { asMockWindow, INDEX_URL } from "../../test/helpers/window-test-harness.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

type WindowModule = typeof import("./window.js");
type LoadFailureModule = typeof import("./window-load-failure.js");

async function loadWindowModule(): Promise<WindowModule> {
  vi.resetModules();
  return import("./window.js");
}

/** Both modules from ONE reset, so the exit code read is the one that was used. */
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

  // A reason carrying an unpaired surrogate is the one input `encodeURIComponent`
  // throws on. `buildLoadFailureUrl` bounds it away, and the recovery guards the
  // call anyway; between them the ladder must still reach the document. Without
  // either, the throw would land inside a `.catch` handler, become an unhandled
  // rejection, and leave the window blank — the exact outcome this ladder exists
  // to prevent.
  it("still serves the document when the reason carries a lone surrogate", async () => {
    electronMock.failLoadsContaining(INDEX_URL, new Error("ERR_\uD800_FAILED"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { createMainWindow } = await loadWindowModule();

    const browserWindow = createMainWindow();

    await vi.waitFor(() => {
      expect(asMockWindow(browserWindow).loadedUrls).toHaveLength(2);
    });
    expect(asMockWindow(browserWindow).loadedUrls[1]).toContain("/-/load-failure");
    expect(browserWindow.isDestroyed()).toBe(false);
    expect(electronMock.exitCodes).toEqual([]);
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

  // The ordinary case, and the one that must not reach `app.exit`. The window is
  // destroyed synchronously after the factory returns — the user closing it —
  // so the rejection handler runs against a window that is already gone.
  describe("a window closed while its load was failing", () => {
    it("serves no document, and does not exit the process", async () => {
      electronMock.failLoadsContaining(INDEX_URL, new Error("ERR_ABORTED (-3)"));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { createMainWindow } = await loadWindowModule();

      const browserWindow = createMainWindow();
      // Synchronous: `loadURL`'s rejection is delivered on a later microtask, so
      // the window is already destroyed by the time the recovery runs.
      browserWindow.destroy();

      await vi.waitFor(() => {
        expect(consoleWarn).toHaveBeenCalled();
      });

      // The whole claim. `app.exit` skips `before-quit` and `will-quit`, so an
      // exit here would silently bypass the sidecar drain on an ordinary close.
      expect(electronMock.exitCodes).toEqual([]);
      // No second load was attempted: there is no surface left to show one on.
      expect(asMockWindow(browserWindow).loadedUrls).toEqual([INDEX_URL]);
      expect(consoleWarn.mock.calls.flat().join(" ")).toContain(
        "closed while its load was failing",
      );
      // The give-up path's own diagnostic must not appear: this is not a
      // renderer that could not be served, it is a window that went away.
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain("no renderer document");
    });
  });
});
