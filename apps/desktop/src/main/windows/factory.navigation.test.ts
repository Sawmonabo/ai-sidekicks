// The navigation policy as installed. The lint rules hold the locked `webPreferences` literal,
// which says nothing about navigation, and a locked window navigated to a remote origin runs
// attacker markup with the same preload, bridge and partition. `./navigation.test.ts` covers
// the pure classifier; this covers the wiring: every seam that can change a window's document
// carries the classification and takes the same decision. The redirect cases are the navigate
// cases with one string changed, because `will-navigate` fires on the original target and
// `will-redirect` is where a 302 to an outside origin is caught.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "#test/helpers/electron/mock/module.js";
import {
  asMockWindow,
  DEV_SERVER_URL,
  INDEX_URL,
  loggedMessages,
  testWindowFrame,
  windowOpenHandlerOf,
} from "#test/helpers/electron/mock/readers.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

type WindowModule = typeof import("./factory.js");

async function loadWindowModule(): Promise<WindowModule> {
  vi.resetModules();
  return import("./factory.js");
}

/** A navigation listener as a case invokes it. */
type NavigationListener = (event: { preventDefault: () => void }, url: string) => void;

/**
 * The listener registered for one navigation event on a window's document. It takes the event
 * because `will-navigate` and `will-redirect` share one classification.
 */
function navigationListenerOf(
  rendererWindow: unknown,
  eventName: "will-navigate" | "will-redirect",
): NavigationListener {
  const listeners = asMockWindow(rendererWindow).document.listenersOf(eventName);
  expect(listeners).toHaveLength(1);
  return listeners[0] as unknown as NavigationListener;
}

/** The two seams that can change a live window's document, by event name. */
const NAVIGATION_SEAMS = ["will-navigate", "will-redirect"] as const;

describe("the navigation policy", () => {
  beforeEach(() => {
    electronMock.reset();
    delete process.env["ELECTRON_RENDERER_URL"];
  });

  afterEach(() => {
    delete process.env["ELECTRON_RENDERER_URL"];
    vi.restoreAllMocks();
  });

  describe.each(NAVIGATION_SEAMS)("on %s", (seam) => {
    it("stops a remote origin and opens it externally instead", async () => {
      const { openHiddenWindow } = await loadWindowModule();
      const rendererWindow = openHiddenWindow({ ...testWindowFrame(), additionalArguments: [] });
      const preventDefault = vi.fn();

      navigationListenerOf(rendererWindow, seam)({ preventDefault }, "https://example.test/docs");
      await vi.waitFor(() => {
        expect(electronMock.externalOpens).toEqual(["https://example.test/docs"]);
      });

      expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it("stops a scheme outside the allowlist and opens nothing", async () => {
      const { openHiddenWindow } = await loadWindowModule();
      const frame = testWindowFrame();
      const rendererWindow = openHiddenWindow({ ...frame, additionalArguments: [] });
      const preventDefault = vi.fn();

      navigationListenerOf(rendererWindow, seam)({ preventDefault }, "file:///etc/passwd");

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(electronMock.externalOpens).toEqual([]);
      expect(loggedMessages(frame.log)).toEqual([
        expect.stringContaining("outside every allowed scheme"),
      ]);
    });

    it("refuses the dev-server origin in a packaged build", async () => {
      electronMock.setPackaged(true);
      process.env["ELECTRON_RENDERER_URL"] = DEV_SERVER_URL;
      const { openHiddenWindow } = await loadWindowModule();
      const rendererWindow = openHiddenWindow({ ...testWindowFrame(), additionalArguments: [] });
      const preventDefault = vi.fn();

      navigationListenerOf(rendererWindow, seam)(
        { preventDefault },
        `${DEV_SERVER_URL}/index.html`,
      );

      // Stopped, and handed to the browser rather than rendered: `http:` is an allowlisted
      // external scheme and a packaged build has no dev origin. Awaited because the open is
      // deferred a turn and would otherwise land in the next case's recording.
      expect(preventDefault).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(electronMock.externalOpens).toEqual([`${DEV_SERVER_URL}/index.html`]);
      });
    });
  });

  it("denies a popup under a name main builds no window for, same origin included", async () => {
    const { openHiddenWindow } = await loadWindowModule();
    const rendererWindow = openHiddenWindow({ ...testWindowFrame(), additionalArguments: [] });

    expect(windowOpenHandlerOf(rendererWindow)({ url: INDEX_URL, frameName: "" })).toEqual({
      action: "deny",
    });
    expect(
      windowOpenHandlerOf(rendererWindow)({ url: "https://example.test/docs", frameName: "" }),
    ).toEqual({ action: "deny" });
    expect(electronMock.externalOpens).toEqual([]);
    await vi.waitFor(() => {
      expect(electronMock.externalOpens).toEqual(["https://example.test/docs"]);
    });
  });
});
